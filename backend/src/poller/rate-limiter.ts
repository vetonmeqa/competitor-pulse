import { setTimeout as sleep } from "node:timers/promises";

/** Time source, replaceable in tests so they run instantly and deterministically. */
export interface Clock {
  /** Milliseconds on a clock that never goes backwards. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: async (ms, signal) => {
    await sleep(ms, undefined, { signal });
  },
};

export interface RateLimiterOptions {
  /** The ceiling. Requests are never started faster than this. */
  maxRatePerSecond: number;
  /** The floor that self-tuning will not go below. */
  minRatePerSecond?: number;
  /** Longest pause accepted from a Retry-After header, in case the header is nonsense. */
  maxPauseMs?: number;
  clock?: Clock;
}

export interface RateLimiterStatus {
  maxRatePerSecond: number;
  currentRatePerSecond: number;
  pausedForMs: number;
  rateLimitedCount: number;
}

// Tuned by simulating against a token bucket like the source's. These values settle at
// about 90% of the source's real limit with roughly two 429s a minute. Halving on each
// 429 (the textbook choice) settled at about 80% with the same number of 429s.

/** How hard to back off when the source says we are too fast: keep 70% of the rate. */
const DECREASE_FACTOR = 0.7;
/** Each accepted request raises the rate by this share of the ceiling. */
const INCREASE_SHARE_PER_SUCCESS = 0.002;

/**
 * Decides when the next request to the source may start.
 *
 * Three behaviours:
 *
 * 1. Even spacing. At 5 requests per second, starts are at least 200 ms apart. There is
 *    no burst allowance, so the source's limit cannot be exceeded even after idle time.
 *    Only the start is limited: slow requests overlap freely.
 * 2. Global pause. When the source answers 429, nothing starts until its Retry-After
 *    has passed, because the limit is shared by all competitors.
 * 3. Self-tuning. A 429 also means the configured rate is too high for this source right
 *    now (a lower limit, or another client sharing it). The rate is cut by 30%, then
 *    creeps back toward the ceiling while requests are accepted.
 *
 * In-memory, so it only limits one process. The worker must be a single instance.
 */
export class AdaptiveRateLimiter {
  private readonly maxRate: number;
  private readonly minRate: number;
  private readonly maxPauseMs: number;
  private readonly increaseStep: number;
  private readonly clock: Clock;

  private rate: number;
  private nextSlotAt = Number.NEGATIVE_INFINITY;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private rateLimitedCount = 0;
  /** Callers wait in line here, so each one gets its own slot. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.maxRate = options.maxRatePerSecond;
    this.minRate = Math.min(options.minRatePerSecond ?? 0.1, this.maxRate);
    this.maxPauseMs = options.maxPauseMs ?? 5 * 60_000;
    this.increaseStep = this.maxRate * INCREASE_SHARE_PER_SUCCESS;
    this.clock = options.clock ?? systemClock;
    this.rate = this.maxRate;
  }

  /** Resolves when the caller may start one request. Rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot(signal));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** The source accepted a request (any answer other than 429). */
  onAccepted(): void {
    if (this.clock.now() < this.pausedUntil) {
      return;
    }
    this.rate = Math.min(this.maxRate, this.rate + this.increaseStep);
  }

  /** The source answered 429. */
  onRateLimited(retryAfterMs: number): void {
    const now = this.clock.now();
    // Requests already in flight can all come back 429. That is one incident, not several.
    const alreadyPaused = now < this.pausedUntil;

    this.rateLimitedCount += 1;
    this.pausedUntil = Math.max(this.pausedUntil, now + Math.min(retryAfterMs, this.maxPauseMs));
    if (!alreadyPaused) {
      this.rate = Math.max(this.minRate, this.rate * DECREASE_FACTOR);
    }
  }

  status(): RateLimiterStatus {
    return {
      maxRatePerSecond: this.maxRate,
      currentRatePerSecond: this.rate,
      pausedForMs: Math.max(0, this.pausedUntil - this.clock.now()),
      rateLimitedCount: this.rateLimitedCount,
    };
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // Re-check after every sleep: a pause may have started, or been extended, meanwhile.
    for (;;) {
      const waitMs = Math.max(this.nextSlotAt, this.pausedUntil) - this.clock.now();
      if (waitMs <= 0) {
        break;
      }
      await this.clock.sleep(waitMs, signal);
    }
    // Stamped when the slot is actually granted, so a late timer can only widen the gap.
    this.nextSlotAt = this.clock.now() + 1000 / this.rate;
  }
}
