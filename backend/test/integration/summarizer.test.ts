import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { competitors, llmUsage, type SnapshotRow, snapshots } from "../../src/db/schema.js";
import { PollStore } from "../../src/poller/poll-store.js";
import { LlmBudget, nextUtcMidnight } from "../../src/summarizer/budget.js";
import { CircuitBreaker } from "../../src/summarizer/circuit-breaker.js";
import {
  type CompletionRequest,
  LlmError,
  type LlmProvider,
} from "../../src/summarizer/llm-provider.js";
import { Summarizer } from "../../src/summarizer/summarizer.js";
import { SummaryStore } from "../../src/summarizer/summary-store.js";
import {
  A,
  addCompetitor,
  B,
  C,
  minutesAgo,
  openTestDb,
  resetTables,
  snapshotsOf,
  waitFor,
} from "./test-db.js";

const { db, pool } = openTestDb();
const pollStore = new PollStore(db);
const summaryStore = new SummaryStore(db);
const log = pino({ level: "silent" });

/** A scripted LLM: answers come from `respond`, and every call is remembered. */
class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: CompletionRequest[] = [];
  respond: (request: CompletionRequest, callNumber: number) => string | Promise<string> = () =>
    "Tagline changed.";

  async complete(request: CompletionRequest): Promise<string> {
    this.calls.push(request);
    return this.respond(request, this.calls.length);
  }
}

/** Never answers; fails as a real provider does when the caller's signal aborts. */
const hang = ({ signal }: CompletionRequest): Promise<string> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new LlmError("aborted", "The LLM call was aborted"));
    });
  });

const fail = (kind: LlmError["kind"]) => (): string => {
  throw new LlmError(kind, `simulated ${kind}`);
};

interface Running {
  summarizer: Summarizer;
  breaker: CircuitBreaker;
  stop: () => Promise<void>;
}

const running: Running[] = [];

/** Everything logged at error level, to assert that a scenario runs without incident. */
function captureErrors() {
  const errors: { msg: string; err?: { message?: string } }[] = [];
  const logger = pino(
    { level: "error" },
    {
      write: (line: string) => {
        errors.push(JSON.parse(line) as { msg: string; err?: { message?: string } });
      },
    },
  );
  return { logger, errors };
}

function startSummarizer(
  provider: LlmProvider,
  options: {
    dailyCap?: number;
    maxAttempts?: number;
    concurrency?: number;
    timeoutMs?: number;
    maxAgeHours?: number;
    breaker?: CircuitBreaker;
    logger?: typeof log;
  } = {},
): Running {
  // By default a breaker that never opens, so only the breaker tests deal with it.
  const breaker = options.breaker ?? new CircuitBreaker({ failureThreshold: 1000 });
  const summarizer = new Summarizer({
    store: summaryStore,
    provider,
    budget: new LlmBudget(db, options.dailyCap ?? 2000),
    breaker,
    log: options.logger ?? log,
    timeoutMs: options.timeoutMs ?? 200,
    maxAttempts: options.maxAttempts ?? 3,
    concurrency: options.concurrency ?? 1,
    maxAgeHours: options.maxAgeHours ?? 48,
    retryDelaysMs: [30, 30],
    idleMs: 10,
  });
  const controller = new AbortController();
  const finished = summarizer.run(controller.signal);
  const handle: Running = {
    summarizer,
    breaker,
    stop: async () => {
      controller.abort();
      await finished;
    },
  };
  running.push(handle);
  return handle;
}

async function stopAll(): Promise<void> {
  await Promise.all(running.splice(0).map((handle) => handle.stop()));
}

/** Adds a competitor whose latest poll is a change waiting for a summary. */
async function addPendingChange(id: string, changedMinutesAgo = 1): Promise<void> {
  await addCompetitor(db, id);
  await pollStore.recordPoll(id, minutesAgo(changedMinutesAgo + 1), { kind: "ok", listing: A });
  await pollStore.recordPoll(id, minutesAgo(changedMinutesAgo), { kind: "ok", listing: B });
}

/** The snapshot that holds a competitor's change. */
async function changeOf(id: string): Promise<SnapshotRow> {
  const change = (await snapshotsOf(db, id)).find((row) => row.changed);
  if (!change) {
    throw new Error(`no change stored for ${id}`);
  }
  return change;
}

const statusOf = async (id: string) => (await changeOf(id)).summaryStatus;

async function llmCallsToday(): Promise<number> {
  const [row] = await db.select().from(llmUsage);
  return row?.calls ?? 0;
}

beforeEach(async () => {
  await resetTables(db);
});

afterEach(stopAll);

afterAll(async () => {
  await pool.end();
});

describe("SummaryStore.claim", () => {
  it("returns the newest change first, with both versions of the listing", async () => {
    await addPendingChange("older", 30);
    await addPendingChange("newer", 5);

    const [job] = await summaryStore.claim(1, 60);
    expect(job).toMatchObject({
      competitorId: "newer",
      changeKind: "content",
      attempt: 1,
      before: A,
      after: B,
    });
  });

  it("does not hand out a claimed job again while its lease lasts", async () => {
    await addPendingChange("acme-crm");
    expect(await summaryStore.claim(1, 60)).toHaveLength(1);
    expect(await summaryStore.claim(1, 60)).toHaveLength(0);
  });

  it("hands a job out again once its lease has run out, as a further attempt", async () => {
    await addPendingChange("acme-crm");
    await summaryStore.claim(1, 0);
    const [again] = await summaryStore.claim(1, 60);
    expect(again?.attempt).toBe(2);
  });

  it("takes several at once when asked, and never the same one twice", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    for (const [index, id] of ids.entries()) {
      await addPendingChange(id, index + 1);
    }
    expect((await summaryStore.claim(4, 60)).map((job) => job.competitorId)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
    ]);

    await resetTables(db);
    for (const id of ids) {
      await addPendingChange(id);
    }
    const claims = await Promise.all(ids.map(() => summaryStore.claim(1, 60)));
    const claimed = claims.flat().map((job) => job.competitorId);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("ignores snapshots that need no LLM summary", async () => {
    await addCompetitor(db, "acme-crm");
    for (const listing of [A, A, B, A]) {
      // baseline, unchanged, change (pending), revert (template)
      await pollStore.recordPoll("acme-crm", new Date(), { kind: "ok", listing });
    }
    await pollStore.recordPoll("acme-crm", new Date(), { kind: "not_found" });
    expect(await summaryStore.claim(10, 60)).toHaveLength(1);
  });
});

describe("Summarizer", () => {
  it("writes a summary for a pending change, with one LLM call", async () => {
    await addPendingChange("acme-crm");
    const provider = new FakeProvider();
    provider.respond = () => "  The tagline changed from\n one wording to another.  ";
    startSummarizer(provider);

    await waitFor(async () => (await statusOf("acme-crm")) === "done");
    await stopAll();

    expect(await changeOf("acme-crm")).toMatchObject({
      summary: "The tagline changed from one wording to another.",
      summaryStatus: "done",
      summarySource: "llm",
      summaryError: null,
      summaryAttempts: 1,
      summaryNextAttemptAt: null,
      changed: true,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.user).toContain(
      'acme-crm changed: tagline "Simple CRM for small teams" -> "The CRM small teams love"',
    );
    expect(await llmCallsToday()).toBe(1);
  });

  it("summarises the newest changes first", async () => {
    await addPendingChange("oldest", 50);
    await addPendingChange("newest", 2);
    await addPendingChange("middle", 20);
    const provider = new FakeProvider();
    startSummarizer(provider);

    await waitFor(() => provider.calls.length === 3);
    await stopAll();

    const order = provider.calls.map((call) => call.user.split(" ")[0]);
    expect(order).toEqual(["newest", "middle", "oldest"]);
  });

  it("makes no LLM call when nothing needs a summary", async () => {
    await addCompetitor(db, "acme-crm");
    for (const listing of [A, A, A]) {
      await pollStore.recordPoll("acme-crm", new Date(), { kind: "ok", listing });
    }
    const provider = new FakeProvider();
    startSummarizer(provider);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await stopAll();
    expect(provider.calls).toHaveLength(0);
    expect(await llmCallsToday()).toBe(0);
  });

  describe("when the LLM fails", () => {
    it("retries after a delay and keeps the result of the attempt that works", async () => {
      await addPendingChange("acme-crm");
      const provider = new FakeProvider();
      provider.respond = (_request, call) => {
        if (call === 1) {
          throw new LlmError("http", "The LLM answered with HTTP 500");
        }
        return "Second time lucky.";
      };
      startSummarizer(provider);

      // Between the attempts the user can see that it is being retried, and why.
      await waitFor(async () => (await changeOf("acme-crm")).summaryError === "llm_error");
      expect(await changeOf("acme-crm")).toMatchObject({ summaryStatus: "pending", summary: null });

      await waitFor(async () => (await statusOf("acme-crm")) === "done");
      await stopAll();
      expect(await changeOf("acme-crm")).toMatchObject({
        summary: "Second time lucky.",
        summaryError: null,
        summaryAttempts: 2,
      });
      expect(await llmCallsToday()).toBe(2);
    });

    it.each([
      ["answers too slowly", hang, "llm_timeout"],
      ["returns an error", fail("http"), "llm_error"],
      ["cannot be reached", fail("unreachable"), "llm_error"],
      ["returns an empty answer", () => "   ", "llm_invalid_response"],
      ["returns a runaway answer", () => "x".repeat(5000), "llm_invalid_response"],
    ])("gives up after three attempts when it %s", async (_label, respond, expectedError) => {
      await addPendingChange("acme-crm");
      const provider = new FakeProvider();
      provider.respond = respond;
      startSummarizer(provider, { timeoutMs: 60 });

      await waitFor(async () => (await statusOf("acme-crm")) === "failed");
      await stopAll();

      expect(await changeOf("acme-crm")).toMatchObject({
        summary: null,
        summaryStatus: "failed",
        summaryError: expectedError,
        summaryAttempts: 3,
        summaryNextAttemptAt: null,
      });
      expect(provider.calls).toHaveLength(3);
      // Every attempt counts against the cap, including the ones that failed.
      expect(await llmCallsToday()).toBe(3);
    });

    it("never loses or alters the poll result", async () => {
      await addPendingChange("acme-crm");
      const before = await snapshotsOf(db, "acme-crm");
      const provider = new FakeProvider();
      provider.respond = fail("http");
      startSummarizer(provider);

      await waitFor(async () => (await statusOf("acme-crm")) === "failed");
      await stopAll();

      const after = await snapshotsOf(db, "acme-crm");
      expect(after).toHaveLength(before.length);
      for (const [index, row] of after.entries()) {
        expect(row).toMatchObject({
          fetchedAt: before[index]?.fetchedAt,
          status: "ok",
          versionId: before[index]?.versionId,
          prevVersionId: before[index]?.prevVersionId,
          changed: before[index]?.changed,
        });
      }
    });

    it("keeps recording polls while an LLM call hangs", async () => {
      await addPendingChange("acme-crm");
      const provider = new FakeProvider();
      provider.respond = hang;
      startSummarizer(provider, { timeoutMs: 5000 });
      await waitFor(() => provider.calls.length === 1);

      const startedAt = Date.now();
      const recorded = await pollStore.recordPoll("acme-crm", new Date(), { kind: "ok", listing: C });
      expect(recorded?.decision.changed).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(500);
    });
  });

  describe("daily cap", () => {
    it("stops calling the LLM at the cap and tells the user why the rest are waiting", async () => {
      for (const [index, id] of ["c1", "c2", "c3", "c4"].entries()) {
        await addPendingChange(id, index + 1);
      }
      const provider = new FakeProvider();
      const { summarizer } = startSummarizer(provider, { dailyCap: 2 });

      await waitFor(async () => (await changeOf("c4")).summaryError === "daily_cap_reached");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await stopAll();

      // The two newest got summaries; exactly two calls were made.
      expect(provider.calls).toHaveLength(2);
      expect(await llmCallsToday()).toBe(2);
      expect(await statusOf("c1")).toBe("done");
      expect(await statusOf("c2")).toBe("done");

      const resetsAt = nextUtcMidnight(new Date());
      for (const id of ["c3", "c4"]) {
        expect(await changeOf(id)).toMatchObject({
          summary: null,
          summaryStatus: "pending",
          summaryError: "daily_cap_reached",
          summaryNextAttemptAt: resetsAt,
          // Being parked is not a failed attempt.
          summaryAttempts: 0,
        });
      }
      expect(summarizer.status().summaries).toMatchObject({ done: 2, failed: 0 });
    });

    it("parks a large backlog cleanly when several workers hit the cap together", async () => {
      const ids = Array.from({ length: 30 }, (_unused, index) => `c${index}`);
      for (const [index, id] of ids.entries()) {
        await addPendingChange(id, index + 1);
      }
      const { logger, errors } = captureErrors();
      const provider = new FakeProvider();
      startSummarizer(provider, { dailyCap: 2, concurrency: 4, logger });

      await waitFor(async () => {
        const changes = await Promise.all(ids.map(changeOf));
        return changes.every(
          (c) => c.summaryStatus === "done" || c.summaryError === "daily_cap_reached",
        );
      });
      await stopAll();

      expect(errors.map((entry) => entry.err?.message ?? entry.msg)).toEqual([]);
      expect(provider.calls).toHaveLength(2);
      const changes = await Promise.all(ids.map(changeOf));
      expect(changes.filter((c) => c.summaryStatus === "done")).toHaveLength(2);
      expect(changes.filter((c) => c.summaryStatus === "pending").map((c) => c.summaryAttempts)).toEqual(
        Array.from({ length: 28 }, () => 0),
      );
    });

    it("also parks a change that arrives after the cap was reached", async () => {
      await addPendingChange("c1");
      const provider = new FakeProvider();
      startSummarizer(provider, { dailyCap: 1 });
      await waitFor(async () => (await statusOf("c1")) === "done");

      await addPendingChange("late");
      await waitFor(async () => (await changeOf("late")).summaryError === "daily_cap_reached");
      await stopAll();
      expect(provider.calls).toHaveLength(1);
    });

    it("summarises the parked changes once the budget has reset", async () => {
      await addPendingChange("c1");
      await addPendingChange("c2", 2);
      const provider = new FakeProvider();
      startSummarizer(provider, { dailyCap: 1 });
      await waitFor(async () => (await changeOf("c2")).summaryError === "daily_cap_reached");

      // A new UTC day: yesterday's usage no longer counts and the parked job is due.
      await db.update(llmUsage).set({ day: "2026-01-01" });
      await db
        .update(snapshots)
        .set({ summaryNextAttemptAt: new Date() })
        .where(eq(snapshots.summaryStatus, "pending"));

      await waitFor(async () => (await statusOf("c2")) === "done");
      await stopAll();
      expect(await changeOf("c2")).toMatchObject({ summaryError: null, summaryAttempts: 1 });
    });
  });

  describe("circuit breaker", () => {
    it("stops calling a failing LLM, explains the wait, and resumes when it recovers", async () => {
      const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
      for (const [index, id] of ids.entries()) {
        await addPendingChange(id, index + 1);
      }
      const provider = new FakeProvider();
      let llmIsDown = true;
      provider.respond = () => {
        if (llmIsDown) {
          throw new LlmError("unreachable", "The LLM could not be reached");
        }
        return "Back in business.";
      };
      const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
      startSummarizer(provider, { breaker });

      // Three failures open the breaker. After that, no further calls are made.
      await waitFor(() => breaker.status().state === "open");
      await waitFor(async () => (await changeOf("c6")).summaryError === "llm_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(provider.calls).toHaveLength(3);
      expect(await llmCallsToday()).toBe(3);
      for (const id of ids) {
        expect(await changeOf(id)).toMatchObject({
          summaryStatus: "pending",
          summaryError: "llm_unavailable",
        });
      }
      await stopAll();

      // The LLM recovers. A breaker with a short cooldown lets one test call through.
      llmIsDown = false;
      const recovering = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
      recovering.tryAcquire();
      recovering.onFailure();
      startSummarizer(provider, { breaker: recovering });

      await waitFor(async () => {
        const statuses = await Promise.all(ids.map(statusOf));
        return statuses.every((status) => status === "done");
      });
      await stopAll();
      expect(recovering.status().state).toBe("closed");
      for (const id of ids) {
        expect((await changeOf(id)).summaryError).toBeNull();
      }
    });

    it("flags a large backlog cleanly when several workers find the LLM down", async () => {
      const ids = Array.from({ length: 30 }, (_unused, index) => `c${index}`);
      for (const [index, id] of ids.entries()) {
        await addPendingChange(id, index + 1);
      }
      const { logger, errors } = captureErrors();
      const provider = new FakeProvider();
      provider.respond = fail("unreachable");
      const breaker = new CircuitBreaker({ failureThreshold: 4, cooldownMs: 60_000 });
      startSummarizer(provider, { breaker, concurrency: 4, logger });

      await waitFor(async () => {
        const changes = await Promise.all(ids.map(changeOf));
        return changes.every((c) => c.summaryError === "llm_unavailable");
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await stopAll();

      expect(errors.map((entry) => entry.err?.message ?? entry.msg)).toEqual([]);
      // Calls already in flight when the breaker opened may finish, but no more start.
      expect(provider.calls.length).toBeGreaterThanOrEqual(4);
      expect(provider.calls.length).toBeLessThanOrEqual(7);
    });

    it("does not count waiting for the LLM as failed attempts", async () => {
      await addPendingChange("c1", 1);
      await addPendingChange("c2", 2);
      const provider = new FakeProvider();
      provider.respond = fail("http");
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
      startSummarizer(provider, { breaker });

      await waitFor(async () => (await changeOf("c2")).summaryError === "llm_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await stopAll();

      // c1 used one attempt; c2 was never sent and has all of its attempts left.
      expect((await changeOf("c1")).summaryAttempts).toBe(1);
      expect((await changeOf("c2")).summaryAttempts).toBe(0);
      expect(await statusOf("c1")).toBe("pending");
    });
  });

  it("runs several LLM calls at once, up to the configured number", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    for (const id of ids) {
      await addPendingChange(id);
    }
    let active = 0;
    let mostActive = 0;
    const provider = new FakeProvider();
    provider.respond = async () => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return "Done.";
    };
    startSummarizer(provider, { concurrency: 2 });

    await waitFor(async () => (await Promise.all(ids.map(statusOf))).every((s) => s === "done"));
    await stopAll();
    expect(mostActive).toBe(2);
    expect(provider.calls).toHaveLength(6);
  });

  it("gives up on a change that is too old, without calling the LLM", async () => {
    await addPendingChange("stale", 49 * 60);
    await addPendingChange("fresh", 47 * 60);
    const provider = new FakeProvider();
    startSummarizer(provider, { maxAgeHours: 48 });

    await waitFor(async () => (await statusOf("stale")) === "failed");
    await waitFor(async () => (await statusOf("fresh")) === "done");
    await stopAll();

    expect(await changeOf("stale")).toMatchObject({ summaryError: "expired", summaryAttempts: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it("puts the job back when the worker shuts down in the middle of a call", async () => {
    await addPendingChange("acme-crm");
    const provider = new FakeProvider();
    provider.respond = hang;
    const { breaker } = startSummarizer(provider, {
      timeoutMs: 5000,
      breaker: new CircuitBreaker({ failureThreshold: 1 }),
    });

    await waitFor(() => provider.calls.length === 1);
    await stopAll();

    const change = await changeOf("acme-crm");
    expect(change).toMatchObject({ summaryStatus: "pending", summaryAttempts: 0 });
    expect(change.summaryNextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now());
    // Our own shutdown is not evidence that the LLM is down.
    expect(breaker.status().state).toBe("closed");
  });

  it("survives a competitor being removed while its summary is being written", async () => {
    await addPendingChange("removed");
    await addPendingChange("kept", 5);
    const provider = new FakeProvider();
    provider.respond = async ({ user }) => {
      if (user.startsWith("removed")) {
        await db.delete(competitors).where(eq(competitors.id, "removed"));
      }
      return "Done.";
    };
    startSummarizer(provider);

    await waitFor(async () => (await statusOf("kept")) === "done");
    await stopAll();
    expect(provider.calls).toHaveLength(2);
  });
});
