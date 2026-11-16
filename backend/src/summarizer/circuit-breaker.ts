export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one test call is allowed. */
  cooldownMs?: number;
  /** The cooldown doubles each time a test call fails, up to this. */
  maxCooldownMs?: number;
  now?: () => number;
}

export interface CircuitBreakerStatus {
  /**
   * `closed`: calls flow normally. `open`: calls are blocked. `half_open`: the cooldown
   * is over and one test call decides whether to close or open again.
   */
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  /** Time until the next test call is allowed, while open. */
  retryInMs: number;
}

/**
 * Stops calling the LLM while it is clearly down.
 *
 * Every attempt counts against the hard daily cap, so retrying each pending summary
 * against a dead service would burn the day's budget on failures. After a run of
 * consecutive failures the breaker blocks all calls for a cooldown, then lets a single
 * test call through. If that works, calls resume. If not, it waits again, twice as long.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  private state: CircuitBreakerStatus["state"] = "closed";
  private consecutiveFailures = 0;
  private cooldownMs: number;
  private openUntil = 0;
  private testCallInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.baseCooldownMs = options.cooldownMs ?? 30_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 5 * 60_000;
    this.now = options.now ?? (() => performance.now());
    this.cooldownMs = this.baseCooldownMs;
  }

  /**
   * Asks permission to make one call. A caller that gets `true` must report back with
   * `onSuccess`, `onFailure`, or `release` (if it ends up not making the call).
   */
  tryAcquire(): boolean {
    if (this.state === "closed") {
      return true;
    }
    if (this.state === "open") {
      if (this.now() < this.openUntil) {
        return false;
      }
      this.state = "half_open";
      this.testCallInFlight = false;
    }
    // Half open: exactly one test call at a time, however many workers are asking.
    if (this.testCallInFlight) {
      return false;
    }
    this.testCallInFlight = true;
    return true;
  }

  /** The permitted call was not made after all (no work, or no budget). */
  release(): void {
    this.testCallInFlight = false;
  }

  onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.cooldownMs = this.baseCooldownMs;
    this.testCallInFlight = false;
  }

  onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open") {
      // The test call failed: wait again, longer.
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.open();
    } else if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
    // Already open: a late failure from a call that was in flight changes nothing.
  }

  status(): CircuitBreakerStatus {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryInMs: this.state === "open" ? Math.max(0, this.openUntil - this.now()) : 0,
    };
  }

  private open(): void {
    this.state = "open";
    this.openUntil = this.now() + this.cooldownMs;
    this.testCallInFlight = false;
  }
}
