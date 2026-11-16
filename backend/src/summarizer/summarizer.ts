import type { Logger } from "../logger.js";
import { pause } from "../util/pause.js";
import { type LlmBudget, nextUtcMidnight } from "./budget.js";
import type { CircuitBreaker, CircuitBreakerStatus } from "./circuit-breaker.js";
import { LlmError, type LlmProvider, toSummaryError } from "./llm-provider.js";
import { buildUserPrompt, type SummaryJob, SYSTEM_PROMPT, validateSummary } from "./prompt.js";
import type { SummaryStore } from "./summary-store.js";

export interface SummarizerOptions {
  store: SummaryStore;
  provider: LlmProvider;
  budget: LlmBudget;
  breaker: CircuitBreaker;
  log: Logger;
  /** Budget for one LLM call. */
  timeoutMs: number;
  /** Attempts per summary before giving up. */
  maxAttempts: number;
  /** LLM calls that may run at once. */
  concurrency: number;
  /** Pending summaries older than this are given up on. */
  maxAgeHours: number;
  /** Wait before attempt 2, attempt 3, and so on. The last value repeats. */
  retryDelaysMs?: number[];
  /** How long to wait before looking again when there is nothing to do. */
  idleMs?: number;
}

export interface SummarizerStatus {
  provider: string;
  breaker: CircuitBreakerStatus;
  /** Since the worker started. */
  summaries: { done: number; retried: number; failed: number; deferredForCap: number };
}

const EXPIRY_CHECK_INTERVAL_MS = 60_000;
/** Extra time on top of the call timeout before a claimed job is considered abandoned. */
const LEASE_MARGIN_SECONDS = 30;

/**
 * Writes the LLM summaries, separately from polling.
 *
 * The poller has already stored each change with a `pending` summary, so nothing here
 * can lose a poll result: a slow, failing or missing LLM only delays or drops the summary
 * text. This loop takes pending summaries, newest first, and for each one:
 *
 * 1. asks the circuit breaker whether the LLM may be called at all,
 * 2. reserves one call from the daily cap,
 * 3. calls the LLM with a timeout and checks that the answer is usable.
 *
 * A failed attempt is retried later with a growing delay, and given up after
 * `maxAttempts`. Either way the snapshot keeps its field-by-field changes.
 */
export class Summarizer {
  private readonly store: SummaryStore;
  private readonly provider: LlmProvider;
  private readonly budget: LlmBudget;
  private readonly breaker: CircuitBreaker;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly maxAgeHours: number;
  private readonly retryDelaysMs: number[];
  private readonly idleMs: number;
  private readonly leaseSeconds: number;

  private readonly counts: SummarizerStatus["summaries"] = {
    done: 0,
    retried: 0,
    failed: 0,
    deferredForCap: 0,
  };
  /** True while pending rows carry the "LLM is not responding" reason. */
  private flaggedUnavailable = false;
  /** Avoids logging "cap reached" for every summary deferred on the same day. */
  private capLoggedFor: string | null = null;

  constructor(options: SummarizerOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.budget = options.budget;
    this.breaker = options.breaker;
    this.log = options.log;
    this.timeoutMs = options.timeoutMs;
    this.maxAttempts = options.maxAttempts;
    this.concurrency = options.concurrency;
    this.maxAgeHours = options.maxAgeHours;
    this.retryDelaysMs = options.retryDelaysMs ?? [15_000, 60_000];
    this.idleMs = options.idleMs ?? 1000;
    this.leaseSeconds = Math.ceil(options.timeoutMs / 1000) + LEASE_MARGIN_SECONDS;
  }

  /** Runs until `signal` aborts. Calls in flight are aborted and their jobs put back. */
  async run(signal: AbortSignal): Promise<void> {
    const workers = Array.from({ length: this.concurrency }, () => this.work(signal));
    await Promise.all([...workers, this.expireOldJobs(signal)]);
  }

  status(): SummarizerStatus {
    return {
      provider: this.provider.name,
      breaker: this.breaker.status(),
      summaries: { ...this.counts },
    };
  }

  private async work(signal: AbortSignal): Promise<void> {
    // Read through a function: the signal can abort during any await in the loop.
    const stopping = (): boolean => signal.aborted;

    while (!stopping()) {
      try {
        const worked = await this.processNext(signal);
        if (!worked) {
          await pause(this.idleMs, signal);
        }
      } catch (error) {
        if (stopping()) {
          break;
        }
        // Most likely the database is briefly unreachable. Keep going.
        this.log.error({ err: error }, "summary loop failed, retrying shortly");
        await pause(1000, signal);
      }
    }
  }

  /** Handles at most one pending summary. Returns false when there was nothing to do. */
  private async processNext(shutdown: AbortSignal): Promise<boolean> {
    if (!this.breaker.tryAcquire()) {
      await this.store.flagLlmUnavailable();
      this.flaggedUnavailable = true;
      return false;
    }

    let job: SummaryJob | undefined;
    try {
      [job] = await this.store.claim(1, this.leaseSeconds);
      if (job === undefined) {
        this.breaker.release();
        return false;
      }
      if (!(await this.budget.tryReserve())) {
        this.breaker.release();
        await this.deferForCap(job);
        return false;
      }
    } catch (error) {
      this.breaker.release();
      throw error;
    }

    await this.summarise(job, shutdown);
    return true;
  }

  private async summarise(job: SummaryJob, shutdown: AbortSignal): Promise<void> {
    let summary: string;
    try {
      const text = await this.provider.complete({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(job),
        signal: AbortSignal.any([shutdown, AbortSignal.timeout(this.timeoutMs)]),
      });
      summary = validateSummary(text);
    } catch (error) {
      await this.handleFailure(job, error, shutdown);
      return;
    }

    this.breaker.onSuccess();
    await this.store.saveSummary(job.snapshotId, summary);
    this.counts.done += 1;
    this.log.info(
      { snapshotId: job.snapshotId, competitorId: job.competitorId, attempt: job.attempt },
      "summary written",
    );

    if (this.flaggedUnavailable) {
      this.flaggedUnavailable = false;
      await this.store.clearLlmUnavailable();
    }
  }

  private async handleFailure(
    job: SummaryJob,
    error: unknown,
    shutdown: AbortSignal,
  ): Promise<void> {
    if (shutdown.aborted) {
      // We cut the call short ourselves. That says nothing about the LLM or the job.
      this.breaker.release();
      await this.store.release(job.snapshotId);
      return;
    }

    const llmError =
      error instanceof LlmError
        ? error
        : new LlmError("unreachable", "The LLM call failed unexpectedly", { cause: error });
    this.breaker.onFailure();

    const reason = toSummaryError(llmError);
    const details = {
      snapshotId: job.snapshotId,
      competitorId: job.competitorId,
      attempt: job.attempt,
      reason,
      detail: llmError.message,
    };

    if (job.attempt >= this.maxAttempts) {
      await this.store.markFailed(job.snapshotId, reason);
      this.counts.failed += 1;
      this.log.warn(details, "summary failed, giving up");
      return;
    }

    const delayMs = this.retryDelaysMs[job.attempt - 1] ?? this.retryDelaysMs.at(-1) ?? 60_000;
    await this.store.retryLater(job.snapshotId, reason, delayMs / 1000);
    this.counts.retried += 1;
    this.log.warn({ ...details, retryInMs: delayMs }, "summary attempt failed, will retry");
  }

  private async deferForCap(job: SummaryJob): Promise<void> {
    const now = new Date();
    const resetsAt = nextUtcMidnight(now);
    await this.store.deferForCap(job.snapshotId, resetsAt);
    this.counts.deferredForCap += 1;

    const today = now.toISOString().slice(0, 10);
    if (this.capLoggedFor !== today) {
      this.capLoggedFor = today;
      this.log.warn({ resetsAt }, "daily LLM cap reached, summaries wait until it resets");
    }
  }

  private async expireOldJobs(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const expired = await this.store.expireOlderThan(this.maxAgeHours);
        if (expired > 0) {
          this.log.warn({ expired, maxAgeHours: this.maxAgeHours }, "gave up on old summaries");
        }
      } catch (error) {
        this.log.error({ err: error }, "could not expire old summaries");
      }
      await pause(EXPIRY_CHECK_INTERVAL_MS, signal);
    }
  }
}
