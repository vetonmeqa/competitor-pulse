import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/summarizer/circuit-breaker.js";

function setup(options: { failureThreshold?: number; cooldownMs?: number; maxCooldownMs?: number } = {}) {
  let time = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1000,
    maxCooldownMs: 4000,
    ...options,
    now: () => time,
  });
  return {
    breaker,
    advance: (ms: number) => {
      time += ms;
    },
    /** One permitted call that fails. */
    fail: () => {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.onFailure();
    },
    /** One permitted call that succeeds. */
    succeed: () => {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.onSuccess();
    },
  };
}

describe("CircuitBreaker", () => {
  it("lets calls through while the LLM works", () => {
    const { breaker, succeed } = setup();
    for (let i = 0; i < 10; i++) {
      succeed();
    }
    expect(breaker.status()).toEqual({ state: "closed", consecutiveFailures: 0, retryInMs: 0 });
  });

  it("stays closed for failures that are not consecutive", () => {
    const { breaker, fail, succeed } = setup();
    for (let i = 0; i < 5; i++) {
      fail();
      fail();
      succeed();
    }
    expect(breaker.status().state).toBe("closed");
  });

  it("opens after the threshold of consecutive failures and blocks every call", () => {
    const { breaker, fail } = setup();
    fail();
    fail();
    expect(breaker.status().state).toBe("closed");
    fail();

    expect(breaker.status()).toEqual({ state: "open", consecutiveFailures: 3, retryInMs: 1000 });
    for (let i = 0; i < 20; i++) {
      expect(breaker.tryAcquire()).toBe(false);
    }
  });

  it("allows exactly one test call once the cooldown is over", () => {
    const { breaker, fail, advance } = setup();
    fail();
    fail();
    fail();

    advance(999);
    expect(breaker.tryAcquire()).toBe(false);
    advance(1);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.status().state).toBe("half_open");
    // Other workers asking while the test call is in flight are refused.
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it("closes again when the test call succeeds", () => {
    const { breaker, fail, advance, succeed } = setup();
    fail();
    fail();
    fail();
    advance(1000);
    succeed();

    expect(breaker.status()).toEqual({ state: "closed", consecutiveFailures: 0, retryInMs: 0 });
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("waits twice as long each time the test call fails, up to the maximum", () => {
    const { breaker, fail, advance } = setup();
    fail();
    fail();
    fail();

    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      advance(breaker.status().retryInMs);
      fail();
      waits.push(breaker.status().retryInMs);
    }
    expect(waits).toEqual([2000, 4000, 4000, 4000]);
  });

  it("goes back to the short cooldown after a recovery", () => {
    const { breaker, fail, advance, succeed } = setup();
    fail();
    fail();
    fail();
    advance(1000);
    fail(); // cooldown is now 2000
    advance(2000);
    succeed();

    fail();
    fail();
    fail();
    expect(breaker.status().retryInMs).toBe(1000);
  });

  it("frees the test slot when the permitted call is not made after all", () => {
    const { breaker, fail, advance } = setup();
    fail();
    fail();
    fail();
    advance(1000);

    expect(breaker.tryAcquire()).toBe(true);
    breaker.release(); // e.g. there was no pending summary to send
    expect(breaker.status().state).toBe("half_open");
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("ignores a late failure from a call that was in flight when it opened", () => {
    const { breaker, advance } = setup();
    // Four calls start while closed; the first three fail and open the circuit.
    for (let i = 0; i < 4; i++) {
      expect(breaker.tryAcquire()).toBe(true);
    }
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    advance(400);
    breaker.onFailure();

    // Still the original cooldown, not restarted or doubled.
    expect(breaker.status()).toMatchObject({ state: "open", retryInMs: 600 });
  });

  it("limits what an all-day outage can cost", () => {
    // Real defaults: 5 failures to open, then a test call every 30s, 60s, ... up to 5 min.
    let time = 0;
    const breaker = new CircuitBreaker({ now: () => time });
    let calls = 0;
    const DAY_MS = 24 * 60 * 60_000;
    while (time < DAY_MS) {
      if (breaker.tryAcquire()) {
        calls += 1;
        breaker.onFailure();
      }
      time += 1000; // a worker asks every second
    }
    // 5 to open, then about one test call per 5 minutes: roughly 290 of the 2,000 cap.
    expect(calls).toBeGreaterThan(280);
    expect(calls).toBeLessThan(300);
  });
});
