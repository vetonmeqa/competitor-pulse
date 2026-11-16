import type { Logger } from "../logger.js";
import type { FetchResult, ListingSource } from "../source/listing-source.js";
import { pause } from "../util/pause.js";
import type { PollStore } from "./poll-store.js";
import type { AdaptiveRateLimiter, RateLimiterStatus } from "./rate-limiter.js";

export interface PollerOptions {
  store: PollStore;
  source: ListingSource;
  limiter: AdaptiveRateLimiter;
  log: Logger;
  pollIntervalSeconds: number;
  /** Upper bound on polls running at once. Slow responses overlap up to this many. */
  maxInFlight: number;
  /** How long to wait before looking again when no competitor is due. */
  idleMs?: number;
}

export interface PollerStatus {
  inFlight: number;
  polls: Record<FetchResult["kind"], number>;
  rateLimiter: RateLimiterStatus;
}

/**
 * The scheduler. One loop that, at the pace the rate limiter allows, takes the most
 * overdue competitor from the queue and polls it.
 *
 * The loop only *starts* polls; each poll then runs on its own. So one slow or hanging
 * request never holds up the others.
 */
export class Poller {
  private readonly store: PollStore;
  private readonly source: ListingSource;
  private readonly limiter: AdaptiveRateLimiter;
  private readonly log: Logger;
  private readonly pollIntervalSeconds: number;
  private readonly maxInFlight: number;
  private readonly idleMs: number;

  private readonly inFlight = new Set<Promise<void>>();
  private readonly polls: PollerStatus["polls"] = {
    ok: 0,
    not_found: 0,
    incomplete: 0,
    error: 0,
    rate_limited: 0,
  };

  constructor(options: PollerOptions) {
    this.store = options.store;
    this.source = options.source;
    this.limiter = options.limiter;
    this.log = options.log;
    this.pollIntervalSeconds = options.pollIntervalSeconds;
    this.maxInFlight = options.maxInFlight;
    this.idleMs = options.idleMs ?? 500;
  }

  /** Runs until `signal` aborts, then waits for the polls in flight to be recorded. */
  async run(signal: AbortSignal): Promise<void> {
    // Read through a function: the signal can abort during any await in the loop.
    const stopping = (): boolean => signal.aborted;

    while (!stopping()) {
      try {
        await this.startNextPoll(signal);
      } catch (error) {
        if (stopping()) {
          break;
        }
        // Most likely the database is briefly unreachable. Keep the worker alive and retry.
        this.log.error({ err: error }, "poll loop failed, retrying shortly");
        await pause(1000, signal);
      }
    }
    await Promise.allSettled(this.inFlight);
  }

  status(): PollerStatus {
    return {
      inFlight: this.inFlight.size,
      polls: { ...this.polls },
      rateLimiter: this.limiter.status(),
    };
  }

  private async startNextPoll(signal: AbortSignal): Promise<void> {
    while (this.inFlight.size >= this.maxInFlight) {
      await Promise.race(this.inFlight);
    }
    await this.limiter.acquire(signal);

    const competitorId = await this.store.claimNextDue(this.pollIntervalSeconds);
    if (competitorId === null) {
      await pause(this.idleMs, signal);
      return;
    }

    const poll = this.pollOne(competitorId).catch((error: unknown) => {
      // The claim already rescheduled this competitor, so the next interval retries it.
      this.log.error({ err: error, competitorId }, "poll could not be recorded");
    });
    this.inFlight.add(poll);
    void poll.finally(() => this.inFlight.delete(poll));
  }

  private async pollOne(competitorId: string): Promise<void> {
    const result = await this.source.fetchListing(competitorId);
    this.polls[result.kind] += 1;

    if (result.kind === "rate_limited") {
      // The source refused to answer: slow everything down and try this one again first.
      this.limiter.onRateLimited(result.retryAfterMs);
      await this.store.requeueAtFront(competitorId);
      this.log.warn(
        { competitorId, retryAfterMs: result.retryAfterMs, ...this.limiter.status() },
        "rate limited by the source",
      );
      return;
    }

    // A timeout or a dropped connection says nothing about the rate limit either way.
    const answered =
      result.kind !== "error" || (result.reason !== "timeout" && result.reason !== "network");
    if (answered) {
      this.limiter.onAccepted();
    }

    const recorded = await this.store.recordPoll(competitorId, new Date(), result);
    if (recorded === null) {
      this.log.debug({ competitorId }, "competitor was removed during the poll");
      return;
    }
    const { decision, snapshotId } = recorded;
    const details = {
      competitorId,
      snapshotId,
      status: decision.status,
      failureReason: decision.failureReason,
      changeKind: decision.changeKind,
    };
    if (decision.changed) {
      this.log.info({ ...details, changedFields: decision.changedFields }, "change detected");
    } else {
      this.log.debug(details, "polled");
    }
  }
}
