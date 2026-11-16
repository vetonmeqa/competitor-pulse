import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { competitors, snapshots } from "../../src/db/schema.js";
import type { Observation } from "../../src/domain/evaluate.js";
import type { Listing } from "../../src/domain/listing.js";
import { PollStore } from "../../src/poller/poll-store.js";
import {
  A,
  addCompetitor,
  B,
  C,
  getCompetitor,
  minutesAgo,
  openTestDb,
  resetTables,
  snapshotsOf,
  versionCount,
} from "./test-db.js";

const { db, pool } = openTestDb();
const store = new PollStore(db);

const ok = (listing: Listing): Observation => ({ kind: "ok", listing });
const NOT_FOUND: Observation = { kind: "not_found" };
const ID = "acme-crm";

/** Records a series of polls one minute apart and returns their times. */
async function record(observations: Observation[], id = ID): Promise<Date[]> {
  const times: Date[] = [];
  for (const [index, observation] of observations.entries()) {
    const fetchedAt = minutesAgo(observations.length - index);
    times.push(fetchedAt);
    await store.recordPoll(id, fetchedAt, observation);
  }
  return times;
}

beforeEach(async () => {
  await resetTables(db);
});

afterAll(async () => {
  await pool.end();
});

describe("claimNextDue", () => {
  it("returns null when nothing is due", async () => {
    expect(await store.claimNextDue(900)).toBeNull();
    await addCompetitor(db, "later", new Date(Date.now() + 60_000));
    expect(await store.claimNextDue(900)).toBeNull();
  });

  it("takes the most overdue competitor first", async () => {
    await addCompetitor(db, "a-little-late", minutesAgo(3));
    await addCompetitor(db, "very-late", minutesAgo(10));
    await addCompetitor(db, "not-due", new Date(Date.now() + 60_000));

    expect(await store.claimNextDue(900)).toBe("very-late");
    expect(await store.claimNextDue(900)).toBe("a-little-late");
    expect(await store.claimNextDue(900)).toBeNull();
  });

  it("reschedules the claimed competitor one interval ahead", async () => {
    await addCompetitor(db, ID);
    await store.claimNextDue(900);
    const { nextPollAt } = await getCompetitor(db, ID);
    const secondsAhead = (nextPollAt.getTime() - Date.now()) / 1000;
    expect(secondsAhead).toBeGreaterThan(890);
    expect(secondsAhead).toBeLessThan(910);
  });

  it("never gives the same competitor to two claims made at once", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
    for (const id of ids) {
      await addCompetitor(db, id);
    }
    const claims = await Promise.all(ids.map(() => store.claimNextDue(900)));
    const claimed = claims.filter((id) => id !== null);
    expect(new Set(claimed).size).toBe(claimed.length);

    // Whatever the racing claims skipped is still there to be claimed afterwards.
    for (let next = await store.claimNextDue(900); next !== null; ) {
      claimed.push(next);
      next = await store.claimNextDue(900);
    }
    expect(claimed.sort()).toEqual(ids);
  });

  it("puts a requeued competitor back at the head of the queue", async () => {
    await addCompetitor(db, "first", minutesAgo(10));
    await addCompetitor(db, "second", minutesAgo(5));

    expect(await store.claimNextDue(900)).toBe("first");
    await store.requeueAtFront("first");
    expect(await store.claimNextDue(900)).toBe("first");
    expect(await store.claimNextDue(900)).toBe("second");
  });
});

describe("recordPoll", () => {
  beforeEach(async () => {
    await addCompetitor(db, ID);
  });

  it("stores the first listing as a baseline", async () => {
    const [fetchedAt] = await record([ok(A)]);

    const [snapshot] = await snapshotsOf(db, ID);
    expect(snapshot).toMatchObject({
      fetchedAt,
      status: "ok",
      failureReason: null,
      changed: false,
      changeKind: "initial",
      prevVersionId: null,
      summary: null,
      summaryStatus: "none",
    });
    expect(snapshot?.versionId).not.toBeNull();

    const competitor = await getCompetitor(db, ID);
    expect(competitor).toMatchObject({
      availability: "listed",
      currentVersionId: snapshot?.versionId,
      previousVersionId: null,
      lastPolledAt: fetchedAt,
      lastPollStatus: "ok",
      lastChangedAt: null,
    });
  });

  it("stores an unchanged poll without storing the listing text again", async () => {
    await record([ok(A), ok({ ...A }), ok({ ...A })]);

    const rows = await snapshotsOf(db, ID);
    expect(rows.map((row) => row.changed)).toEqual([false, false, false]);
    expect(new Set(rows.map((row) => row.versionId)).size).toBe(1);
    expect(await versionCount(db, ID)).toBe(1);
  });

  it("stores a content change as a pending summary, with both versions", async () => {
    const [, changedAt] = await record([ok(A), ok(C)]);

    const [first, second] = await snapshotsOf(db, ID);
    expect(second).toMatchObject({
      status: "ok",
      changed: true,
      changeKind: "content",
      prevVersionId: first?.versionId,
      summary: null,
      summaryStatus: "pending",
      summarySource: null,
      summaryNextAttemptAt: changedAt,
      summaryAttempts: 0,
    });
    expect(second?.versionId).not.toBe(first?.versionId);

    expect(await getCompetitor(db, ID)).toMatchObject({
      currentVersionId: second?.versionId,
      previousVersionId: first?.versionId,
      lastChangedAt: changedAt,
    });
  });

  it("summarises a revert with a template and reuses the earlier version row", async () => {
    await record([ok(A), ok(B), ok(A)]);

    const [first, second, third] = await snapshotsOf(db, ID);
    expect(third).toMatchObject({
      changed: true,
      changeKind: "revert",
      versionId: first?.versionId,
      prevVersionId: second?.versionId,
      summaryStatus: "done",
      summarySource: "template",
      summaryNextAttemptAt: null,
    });
    expect(third?.summary).toContain("Reverted to the previous version");
    expect(await versionCount(db, ID)).toBe(2);

    expect(await getCompetitor(db, ID)).toMatchObject({
      currentVersionId: first?.versionId,
      previousVersionId: second?.versionId,
    });
  });

  it("spends one pending summary on a listing that flips back and forth", async () => {
    await record([ok(A), ok(B), ok(A), ok(B), ok(A), ok(B)]);

    const rows = await snapshotsOf(db, ID);
    expect(rows.map((row) => row.changeKind)).toEqual([
      "initial",
      "content",
      "revert",
      "revert",
      "revert",
      "revert",
    ]);
    expect(rows.filter((row) => row.summaryStatus === "pending")).toHaveLength(1);
    expect(await versionCount(db, ID)).toBe(2);
  });

  it("reuses an older version row that is neither current nor previous", async () => {
    await record([ok(A), ok(B), ok(C), ok(A)]);

    const rows = await snapshotsOf(db, ID);
    expect(rows[3]).toMatchObject({ changeKind: "content", summaryStatus: "pending" });
    expect(rows[3]?.versionId).toBe(rows[0]?.versionId);
    expect(await versionCount(db, ID)).toBe(3);
  });

  it("stores failed polls without touching the competitor's state", async () => {
    const [changedAt] = await record([ok(A), ok(B)]).then((times) => times.slice(1));
    const before = await getCompetitor(db, ID);

    const failedAt = new Date();
    await store.recordPoll(ID, failedAt, { kind: "error", reason: "timeout" });
    await store.recordPoll(ID, failedAt, { kind: "incomplete", missing: ["price", "tagline"] });

    const rows = await snapshotsOf(db, ID);
    expect(rows.slice(2)).toMatchObject([
      { status: "error", failureReason: "timeout", versionId: null, changed: false },
      { status: "incomplete", failureReason: "missing:price,tagline", versionId: null },
    ]);
    expect(rows.slice(2).every((row) => row.summaryStatus === "none")).toBe(true);

    expect(await getCompetitor(db, ID)).toMatchObject({
      availability: "listed",
      currentVersionId: before.currentVersionId,
      previousVersionId: before.previousVersionId,
      lastChangedAt: changedAt,
      lastPolledAt: failedAt,
      lastPollStatus: "incomplete",
    });
  });

  it("stores a delisting and a relisting", async () => {
    await record([ok(A), NOT_FOUND, NOT_FOUND, ok(A), NOT_FOUND, ok(C)]);

    const rows = await snapshotsOf(db, ID);
    expect(rows.map((row) => [row.status, row.changed, row.changeKind, row.summaryStatus])).toEqual(
      [
        ["ok", false, "initial", "none"],
        ["not_found", true, "delisted", "done"],
        ["not_found", false, null, "none"],
        ["ok", true, "relisted", "done"],
        ["not_found", true, "delisted", "done"],
        ["ok", true, "relisted", "pending"],
      ],
    );
    // The delisting remembers what was last seen; the listing itself is absent.
    expect(rows[1]).toMatchObject({ versionId: null, prevVersionId: rows[0]?.versionId });
    expect(rows[1]?.summary).toContain("no longer available");
    expect(rows[3]?.summary).toContain("available again");
    expect((await getCompetitor(db, ID)).availability).toBe("listed");
  });

  it("keeps the last listing while delisted", async () => {
    await record([ok(A), NOT_FOUND]);
    const [first] = await snapshotsOf(db, ID);
    expect(await getCompetitor(db, ID)).toMatchObject({
      availability: "delisted",
      currentVersionId: first?.versionId,
    });
  });

  it("stores not found for an id the source has never known", async () => {
    await record([NOT_FOUND, NOT_FOUND]);

    const rows = await snapshotsOf(db, ID);
    expect(rows).toMatchObject([
      { status: "not_found", changed: false, changeKind: null, summaryStatus: "none" },
      { status: "not_found", changed: false, changeKind: null, summaryStatus: "none" },
    ]);
    expect(await getCompetitor(db, ID)).toMatchObject({
      availability: "unknown",
      currentVersionId: null,
      lastPollStatus: "not_found",
    });
  });

  it("keeps identical content of two competitors apart", async () => {
    await addCompetitor(db, "other");
    await record([ok(A)]);
    await record([ok(A)], "other");

    const [mine] = await snapshotsOf(db, ID);
    const [theirs] = await snapshotsOf(db, "other");
    expect(mine?.versionId).not.toBe(theirs?.versionId);
  });

  it("writes nothing when the competitor was removed during the poll", async () => {
    await db.delete(competitors).where(eq(competitors.id, ID));
    expect(await store.recordPoll(ID, new Date(), ok(A))).toBeNull();
    expect(await db.$count(snapshots)).toBe(0);
  });

  it("removes a competitor's whole history when it is deleted", async () => {
    await record([ok(A), ok(B), NOT_FOUND, ok(C)]);
    await db.delete(competitors).where(eq(competitors.id, ID));
    expect(await db.$count(snapshots)).toBe(0);
    expect(await versionCount(db, ID)).toBe(0);
  });
});

describe("deleteSnapshotsOlderThan", () => {
  it("deletes only snapshots past the retention period", async () => {
    await addCompetitor(db, ID);
    const days = (count: number) => minutesAgo(count * 24 * 60);
    await store.recordPoll(ID, days(120), ok(A));
    await store.recordPoll(ID, days(91), ok(A));
    await store.recordPoll(ID, days(89), ok(A));
    await store.recordPoll(ID, days(1), ok(B));

    expect(await store.deleteSnapshotsOlderThan(90)).toBe(2);
    expect(await snapshotsOf(db, ID)).toHaveLength(2);
    // The competitor's state does not depend on the deleted rows.
    expect((await getCompetitor(db, ID)).availability).toBe("listed");
  });
});
