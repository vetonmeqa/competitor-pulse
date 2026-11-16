import type { Logger } from "../logger.js";
import { pause } from "../util/pause.js";
import { type LlmBudget, nextUtcMidnight } from "./budget.js";
import type { CircuitBreaker, CircuitBreakerStatus } from "./circuit-breaker.js";
import { LlmError, type LlmProvider, toSummaryError } from "./llm-provider.js";
import {
  BATCH_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  buildUserPrompt,
  parseBatchSummaries,
  type SummaryJob,
  SYSTEM_PROMPT,
  validateSummary,
} from "./prompt.js";
import type { SummaryStore } from "./summary-store.js";

export interface SummarizerOptions {
  store: SummaryStore;
  provider: LlmProvider;
  budget: LlmBudget;
  breaker: CircuitBreaker;
  log: Logger;
  /** Budget for an LLM call that summarises one change. A batch gets more: see `timeoutFor`. */
  timeoutMs: number;
  /** Changes summarised per LLM call. 1 turns batching off. */
  batchSize?: number;
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
 *
 * With a batch size above 1, one call summarises several changes. The cap counts calls,
 * so this stretches it. Nothing waits for a batch to fill: a call takes whatever is
 * pending at that moment, up to the batch size. Each change in the answer is judged on
 * its own, so one unusable entry costs only that change a retry.
 */
export class Summarizer {
  private readonly store: SummaryStore;
  private readonly provider: LlmProvider;
  private readonly budget: LlmBudget;
  private readonly breaker: CircuitBreaker;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
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
    this.batchSize = options.batchSize ?? 1;
    this.concurrency = options.concurrency;
    this.maxAgeHours = options.maxAgeHours;
    this.retryDelaysMs = options.retryDelaysMs ?? [15_000, 60_000];
    this.idleMs = options.idleMs ?? 1000;
    this.leaseSeconds = Math.ceil(this.timeoutFor(this.batchSize) / 1000) + LEASE_MARGIN_SECONDS;
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

  /** Makes at most one LLM call. Returns false when there was nothing to do. */
  private async processNext(shutdown: AbortSignal): Promise<boolean> {
    if (!this.breaker.tryAcquire()) {
      await this.store.flagLlmUnavailable();
      this.flaggedUnavailable = true;
      return false;
    }

    let jobs: SummaryJob[];
    try {
      jobs = await this.store.claim(this.batchSize, this.leaseSeconds);
      if (jobs.length === 0) {
        this.breaker.release();
        return false;
      }
      // One reservation per call, however many changes the call carries.
      if (!(await this.budget.tryReserve())) {
        this.breaker.release();
        await this.deferForCap(jobs);
        return false;
      }
    } catch (error) {
      this.breaker.release();
      throw error;
    }

    await this.callLlm(jobs, shutdown);
    return true;
  }

  private async callLlm(jobs: SummaryJob[], shutdown: AbortSignal): Promise<void> {
    const [first] = jobs;
    if (first === undefined) {
      return;
    }
    const isBatch = jobs.length > 1;

    let text: string;
    try {
      text = await this.provider.complete({
        system: isBatch ? BATCH_SYSTEM_PROMPT : SYSTEM_PROMPT,
        user: isBatch ? buildBatchUserPrompt(jobs) : buildUserPrompt(first),
        signal: AbortSignal.any([shutdown, AbortSignal.timeout(this.timeoutFor(jobs.length))]),
      });
    } catch (error) {
      await this.handleCallFailure(jobs, error, shutdown);
      return;
    }

    // The LLM answered. Now judge the answer, per change.
    let results: Map<number, string | LlmError>;
    try {
      results = isBatch
        ? parseBatchSummaries(text, jobs)
        : new Map([[first.snapshotId, validateSummary(text)]]);
    } catch (error) {
      // Nothing in the answer is usable.
      const unusable = asLlmError(error);
      results = new Map(jobs.map((job) => [job.snapshotId, unusable]));
    }

    let written = 0;
    for (const job of jobs) {
      const result = results.get(job.snapshotId);
      if (typeof result === "string") {
        await this.store.saveSummary(job.snapshotId, result);
        written += 1;
      } else {
        await this.recordFailedAttempt(job, result ?? asLlmError(undefined));
      }
    }
    // At least one usable summary means the LLM is working.
    if (written === 0) {
      this.breaker.onFailure();
      return;
    }
    this.breaker.onSuccess();
    this.counts.done += written;
    this.log.info(
      { snapshotIds: jobs.map((job) => job.snapshotId), written, requested: jobs.length },
      isBatch ? "batch of summaries written" : "summary written",
    );
    if (this.flaggedUnavailable) {
      this.flaggedUnavailable = false;
      await this.store.clearLlmUnavailable();
    }
  }

  /** The call itself failed: no answer, an error status, or a timeout. */
  private async handleCallFailure(
    jobs: SummaryJob[],
    error: unknown,
    shutdown: AbortSignal,
  ): Promise<void> {
    if (shutdown.aborted) {
      // We cut the call short ourselves. That says nothing about the LLM or the jobs.
      this.breaker.release();
      await this.store.release(jobs.map((job) => job.snapshotId));
      return;
    }
    this.breaker.onFailure();
    const llmError = asLlmError(error);
    for (const job of jobs) {
      await this.recordFailedAttempt(job, llmError);
    }
  }

  /** Schedules another attempt for one change, or gives up on it after `maxAttempts`. */
  private async recordFailedAttempt(job: SummaryJob, error: LlmError): Promise<void> {
    const reason = toSummaryError(error);
    const details = {
      snapshotId: job.snapshotId,
      competitorId: job.competitorId,
      attempt: job.attempt,
      reason,
      detail: error.message,
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

  private async deferForCap(jobs: SummaryJob[]): Promise<void> {
    const now = new Date();
    const resetsAt = nextUtcMidnight(now);
    await this.store.deferForCap(
      jobs.map((job) => job.snapshotId),
      resetsAt,
    );
    this.counts.deferredForCap += jobs.length;

    const today = now.toISOString().slice(0, 10);
    if (this.capLoggedFor !== today) {
      this.capLoggedFor = today;
      this.log.warn({ resetsAt }, "daily LLM cap reached, summaries wait until it resets");
    }
  }

  /**
   * A batch produces more text than a single summary, so it gets more time: a quarter of
   * the base timeout for every change beyond the first.
   */
  private timeoutFor(changes: number): number {
    return Math.round(this.timeoutMs * (1 + (changes - 1) / 4));
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

function asLlmError(error: unknown): LlmError {
  return error instanceof LlmError
    ? error
    : new LlmError("unreachable", "The LLM call failed unexpectedly", { cause: error });
}
