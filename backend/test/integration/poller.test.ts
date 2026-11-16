import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { competitors } from "../../src/db/schema.js";
import { PollStore } from "../../src/poller/poll-store.js";
import { Poller } from "../../src/poller/poller.js";
import { AdaptiveRateLimiter } from "../../src/poller/rate-limiter.js";
import type { FetchResult, ListingSource } from "../../src/source/listing-source.js";
import {
  A,
  addCompetitor,
  B,
  getCompetitor,
  openTestDb,
  resetTables,
  snapshotsOf,
  waitFor,
} from "./test-db.js";

const { db, pool } = openTestDb();
const store = new PollStore(db);
const log = pino({ level: "silent" });

/** A scripted source: answers come from `respond`, and every request is remembered. */
class FakeSource implements ListingSource {
  readonly calls: string[] = [];
  respond: (id: string, callNumber: number) => FetchResult | Promise<FetchResult> = () => ({
    kind: "ok",
    listing: A,
  });

  async fetchListing(id: string): Promise<FetchResult> {
    this.calls.push(id);
    return this.respond(id, this.calls.length);
  }
}

interface Running {
  poller: Poller;
  limiter: AdaptiveRateLimiter;
  stop: () => Promise<void>;
}

const running: Running[] = [];

/** Starts a poller with a limiter fast enough not to slow the tests down. */
function startPoller(
  source: ListingSource,
  options: { pollIntervalSeconds?: number; maxInFlight?: number } = {},
): Running {
  const limiter = new AdaptiveRateLimiter({ maxRatePerSecond: 500 });
  const poller = new Poller({
    store,
    source,
    limiter,
    log,
    pollIntervalSeconds: options.pollIntervalSeconds ?? 3600,
    maxInFlight: options.maxInFlight ?? 10,
    idleMs: 10,
  });
  const controller = new AbortController();
  const finished = poller.run(controller.signal);
  const handle: Running = {
    poller,
    limiter,
    stop: async () => {
      controller.abort();
      await finished;
    },
  };
  running.push(handle);
  return handle;
}

const snapshotCount = async (id: string) => (await snapshotsOf(db, id)).length;

beforeEach(async () => {
  await resetTables(db);
});

/** Stops whatever a test started. Also runs after each test, so a failure cannot leak a loop. */
async function stopAll(): Promise<void> {
  await Promise.all(running.splice(0).map((handle) => handle.stop()));
}

afterEach(stopAll);

afterAll(async () => {
  await pool.end();
});

describe("Poller", () => {
  it("polls every due competitor once and records a snapshot for each", async () => {
    const ids = ["acme-crm", "north-analytics", "orbit-hr"];
    for (const id of ids) {
      await addCompetitor(db, id);
    }
    const source = new FakeSource();
    startPoller(source);

    await waitFor(async () => (await Promise.all(ids.map(snapshotCount))).every((n) => n === 1));
    // Not due again for an hour, so nothing more is fetched.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stopAll();

    expect(source.calls.sort()).toEqual(ids);
    for (const id of ids) {
      expect(await getCompetitor(db, id)).toMatchObject({
        availability: "listed",
        lastPollStatus: "ok",
      });
    }
  });

  it("polls a competitor again each interval and records what changed", async () => {
    await addCompetitor(db, "acme-crm");
    const source = new FakeSource();
    source.respond = (_id, call) => ({ kind: "ok", listing: call < 3 ? A : B });
    startPoller(source, { pollIntervalSeconds: 0.05 });

    await waitFor(async () => (await snapshotCount("acme-crm")) >= 3);
    await stopAll();

    const rows = await snapshotsOf(db, "acme-crm");
    expect(rows.slice(0, 3).map((row) => row.changeKind)).toEqual(["initial", null, "content"]);
    expect(rows[2]).toMatchObject({ changed: true, summaryStatus: "pending" });
  });

  it("records failed polls and keeps polling the others", async () => {
    await addCompetitor(db, "flaky");
    await addCompetitor(db, "gone");
    await addCompetitor(db, "fine");
    const source = new FakeSource();
    source.respond = (id) => {
      if (id === "flaky") return { kind: "error", reason: "http_503" };
      if (id === "gone") return { kind: "not_found" };
      return { kind: "ok", listing: A };
    };
    startPoller(source);

    await waitFor(async () => {
      const counts = await Promise.all(["flaky", "gone", "fine"].map(snapshotCount));
      return counts.every((n) => n === 1);
    });
    await stopAll();

    expect(await snapshotsOf(db, "flaky")).toMatchObject([
      { status: "error", failureReason: "http_503", changed: false },
    ]);
    expect(await snapshotsOf(db, "gone")).toMatchObject([{ status: "not_found", changed: false }]);
    expect(await snapshotsOf(db, "fine")).toMatchObject([{ status: "ok" }]);
  });

  it("on a 429, records nothing, slows down and polls that competitor again", async () => {
    await addCompetitor(db, "acme-crm");
    const source = new FakeSource();
    source.respond = (_id, call) =>
      call === 1 ? { kind: "rate_limited", retryAfterMs: 150 } : { kind: "ok", listing: A };
    const { limiter } = startPoller(source);

    const startedAt = Date.now();
    await waitFor(async () => (await snapshotCount("acme-crm")) === 1);
    const waitedMs = Date.now() - startedAt;
    await stopAll();

    expect(source.calls).toEqual(["acme-crm", "acme-crm"]);
    expect(waitedMs).toBeGreaterThanOrEqual(150);
    expect(await snapshotsOf(db, "acme-crm")).toMatchObject([{ status: "ok" }]);
    expect(limiter.status()).toMatchObject({ rateLimitedCount: 1 });
    expect(limiter.status().currentRatePerSecond).toBeLessThan(500);
  });

  it("does not let one hanging request hold up the rest", async () => {
    await addCompetitor(db, "hangs");
    await addCompetitor(db, "fine-1");
    await addCompetitor(db, "fine-2");
    let release: (result: FetchResult) => void = () => undefined;
    const source = new FakeSource();
    source.respond = (id) =>
      id === "hangs"
        ? new Promise<FetchResult>((resolve) => {
            release = resolve;
          })
        : { kind: "ok", listing: A };
    startPoller(source);

    await waitFor(async () => {
      const counts = await Promise.all(["fine-1", "fine-2"].map(snapshotCount));
      return counts.every((n) => n === 1);
    });
    expect(await snapshotCount("hangs")).toBe(0);

    release({ kind: "error", reason: "timeout" });
    await waitFor(async () => (await snapshotCount("hangs")) === 1);
    await stopAll();
  });

  it("never runs more polls at once than allowed", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    for (const id of ids) {
      await addCompetitor(db, id);
    }
    let active = 0;
    let mostActive = 0;
    const source = new FakeSource();
    source.respond = async () => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { kind: "ok", listing: A };
    };
    startPoller(source, { maxInFlight: 2 });

    await waitFor(async () => (await Promise.all(ids.map(snapshotCount))).every((n) => n === 1));
    await stopAll();
    expect(mostActive).toBe(2);
  });

  it("finishes recording the polls in flight when it is stopped", async () => {
    await addCompetitor(db, "acme-crm");
    const source = new FakeSource();
    source.respond = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { kind: "ok", listing: A };
    };
    startPoller(source);

    await waitFor(() => source.calls.length === 1);
    await stopAll();

    expect(await snapshotCount("acme-crm")).toBe(1);
  });

  it("survives a competitor being removed while its poll is in flight", async () => {
    await addCompetitor(db, "removed");
    await addCompetitor(db, "kept");
    const source = new FakeSource();
    source.respond = async (id) => {
      if (id === "removed") {
        await db.delete(competitors).where(eq(competitors.id, "removed"));
      }
      return { kind: "ok", listing: A };
    };
    startPoller(source);

    await waitFor(async () => (await snapshotCount("kept")) === 1);
    await stopAll();
    expect(await snapshotCount("removed")).toBe(0);
  });

  it("keeps going when a poll fails unexpectedly, and retries it next interval", async () => {
    await addCompetitor(db, "acme-crm");
    const source = new FakeSource();
    source.respond = (_id, call) => {
      if (call === 1) {
        throw new Error("bug in the source client");
      }
      return { kind: "ok", listing: A };
    };
    startPoller(source, { pollIntervalSeconds: 0.05 });

    await waitFor(async () => (await snapshotCount("acme-crm")) >= 1);
    await stopAll();
    expect(source.calls.length).toBeGreaterThanOrEqual(2);
  });
});
