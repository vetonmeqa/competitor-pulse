import { describe, expect, it } from "vitest";
import { AdaptiveRateLimiter, type Clock } from "../src/poller/rate-limiter.js";

/** A clock where sleeping just moves time forward, so tests are instant and exact. */
function fakeClock() {
  let time = 0;
  /** Set `onSleep` to make something happen while a caller is waiting. */
  const hooks: { onSleep?: () => void } = {};
  const clock: Clock = {
    now: () => time,
    sleep: (ms, signal) => {
      signal?.throwIfAborted();
      time += ms;
      hooks.onSleep?.();
      return Promise.resolve();
    },
  };
  return {
    clock,
    hooks,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** Acquires `count` slots one after another and returns when each was granted. */
async function grantTimes(
  limiter: AdaptiveRateLimiter,
  now: () => number,
  count: number,
): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    await limiter.acquire();
    times.push(now());
  }
  return times;
}

/** The source's own limit: a token bucket refilled continuously, as in the provided server. */
function sourceBucket(now: () => number, limitAt: (time: number) => number) {
  let tokens = limitAt(0);
  let updatedAt = 0;
  /** Returns 0 when the request is accepted, otherwise the Retry-After in ms. */
  return (): number => {
    const rate = limitAt(now());
    tokens = Math.min(Math.max(1, rate), tokens + ((now() - updatedAt) / 1000) * rate);
    updatedAt = now();
    if (tokens >= 1) {
      tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - tokens) / rate)) * 1000;
  };
}

/** Drives the limiter against a simulated source for a while and counts the outcomes. */
async function simulate(
  limiter: AdaptiveRateLimiter,
  time: ReturnType<typeof fakeClock>,
  limitAt: (time: number) => number,
  durationMs: number,
) {
  const take = sourceBucket(time.now, limitAt);
  const end = time.now() + durationMs;
  let accepted = 0;
  let rejected = 0;
  while (time.now() < end) {
    await limiter.acquire();
    const retryAfterMs = take();
    if (retryAfterMs === 0) {
      accepted += 1;
      limiter.onAccepted();
    } else {
      rejected += 1;
      limiter.onRateLimited(retryAfterMs);
    }
  }
  return { accepted, rejected, acceptedPerSecond: accepted / (durationMs / 1000) };
}

describe("AdaptiveRateLimiter", () => {
  describe("even spacing", () => {
    it("grants the first slot at once and spaces the rest", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      expect(await grantTimes(limiter, time.now, 5)).toEqual([0, 200, 400, 600, 800]);
    });

    it("gives callers that arrive together separate slots, in order", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      const granted: [number, number][] = [];
      await Promise.all(
        [0, 1, 2, 3].map(async (caller) => {
          await limiter.acquire();
          granted.push([caller, time.now()]);
        }),
      );
      expect(granted).toEqual([
        [0, 0],
        [1, 200],
        [2, 400],
        [3, 600],
      ]);
    });

    it("never starts more than the limit in any one-second window", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      const times = await grantTimes(limiter, time.now, 200);
      for (let i = 0; i + 5 < times.length; i++) {
        expect((times[i + 5] ?? 0) - (times[i] ?? 0)).toBeGreaterThanOrEqual(1000);
      }
    });

    it("does not save up unused slots while idle", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      await limiter.acquire();
      time.advance(60_000);
      const times = await grantTimes(limiter, time.now, 3);
      expect(times).toEqual([60_000, 60_200, 60_400]);
    });
  });

  describe("pausing on 429", () => {
    it("starts nothing until Retry-After has passed", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      await limiter.acquire();
      limiter.onRateLimited(3000);
      expect(limiter.status().pausedForMs).toBe(3000);
      await limiter.acquire();
      expect(time.now()).toBe(3000);
    });

    it("also holds back a caller that was already waiting for its slot", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      // The 429 arrives while the second caller is asleep waiting for its 200 ms slot.
      let sleeps = 0;
      time.hooks.onSleep = () => {
        sleeps += 1;
        if (sleeps === 1) {
          limiter.onRateLimited(1000);
        }
      };
      await limiter.acquire();
      await limiter.acquire();
      expect(time.now()).toBe(1200);
    });

    it("keeps the longest pause when several 429s arrive", () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      limiter.onRateLimited(5000);
      limiter.onRateLimited(1000);
      expect(limiter.status().pausedForMs).toBe(5000);
    });

    it("caps a pause that is unreasonably long", () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({
        maxRatePerSecond: 5,
        maxPauseMs: 60_000,
        clock: time.clock,
      });
      limiter.onRateLimited(86_400_000);
      expect(limiter.status().pausedForMs).toBe(60_000);
    });
  });

  describe("self-tuning", () => {
    it("lowers the rate on a 429 and spaces requests further apart", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      limiter.onRateLimited(1000);
      expect(limiter.status().currentRatePerSecond).toBeCloseTo(3.5);

      const [first = 0, second = 0] = await grantTimes(limiter, time.now, 2);
      expect(first).toBe(1000);
      expect(second - first).toBeCloseTo(1000 / 3.5);
    });

    it("counts a burst of 429s from requests already in flight as one incident", () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      for (let i = 0; i < 6; i++) {
        limiter.onRateLimited(1000);
      }
      expect(limiter.status().currentRatePerSecond).toBeCloseTo(3.5);
      expect(limiter.status().rateLimitedCount).toBe(6);
    });

    it("lowers the rate again for a 429 after the pause is over", () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      limiter.onRateLimited(1000);
      time.advance(1500);
      limiter.onRateLimited(1000);
      expect(limiter.status().currentRatePerSecond).toBeCloseTo(2.45);
    });

    it("never goes below the floor", () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({
        maxRatePerSecond: 5,
        minRatePerSecond: 0.5,
        clock: time.clock,
      });
      for (let i = 0; i < 50; i++) {
        limiter.onRateLimited(1000);
        time.advance(2000);
      }
      expect(limiter.status().currentRatePerSecond).toBe(0.5);
    });

    it("climbs back to the ceiling while requests are accepted, and no further", () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      limiter.onRateLimited(1000);
      time.advance(1000);

      limiter.onAccepted();
      expect(limiter.status().currentRatePerSecond).toBeCloseTo(3.51);

      for (let i = 0; i < 1000; i++) {
        limiter.onAccepted();
      }
      expect(limiter.status().currentRatePerSecond).toBe(5);
    });

    it("does not climb on answers that arrive during a pause", () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      limiter.onRateLimited(1000);
      limiter.onAccepted();
      expect(limiter.status().currentRatePerSecond).toBeCloseTo(3.5);
    });
  });

  describe("against a simulated source", () => {
    const TEN_MINUTES = 10 * 60_000;

    it("is never rejected when the configured rate matches the source's limit", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      const result = await simulate(limiter, time, () => 5, TEN_MINUTES);
      expect(result.rejected).toBe(0);
      expect(result.acceptedPerSecond).toBeCloseTo(5, 1);
    });

    it("settles close to a lower limit it was not told about", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      const result = await simulate(limiter, time, () => 2, TEN_MINUTES);
      // Without self-tuning, a third of all requests would be rejected here.
      expect(result.rejected / (result.accepted + result.rejected)).toBeLessThan(0.03);
      expect(result.acceptedPerSecond).toBeGreaterThan(2 * 0.85);
      expect(result.acceptedPerSecond).toBeLessThanOrEqual(2.01);
    });

    it("returns to the ceiling after the source's limit is restored", async () => {
      const time = fakeClock();
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 5, clock: time.clock });
      const limitAt = (at: number) => (at < 3 * 60_000 ? 2 : 5);

      await simulate(limiter, time, limitAt, 3 * 60_000);
      expect(limiter.status().currentRatePerSecond).toBeLessThan(3);

      const after = await simulate(limiter, time, limitAt, 5 * 60_000);
      expect(after.rejected).toBe(0);
      expect(limiter.status().currentRatePerSecond).toBe(5);
    });
  });

  describe("cancelling", () => {
    it("rejects a waiting caller when its signal aborts, without blocking the next one", async () => {
      // Real timers here: this is about interrupting an actual wait.
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 10 });
      await limiter.acquire();

      const controller = new AbortController();
      const cancelled = limiter.acquire(controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toThrow();

      const startedAt = performance.now();
      await limiter.acquire();
      expect(performance.now() - startedAt).toBeLessThan(500);
    });

    it("rejects at once when the signal is already aborted", async () => {
      const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 10 });
      await expect(limiter.acquire(AbortSignal.abort())).rejects.toThrow();
    });
  });
});
