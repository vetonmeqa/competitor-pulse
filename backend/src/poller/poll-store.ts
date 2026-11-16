import { asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { competitors, listingVersions, type NewSnapshotRow, snapshots } from "../db/schema.js";
import {
  type CompetitorState,
  evaluatePoll,
  type Observation,
  type PollDecision,
  type SummaryPlan,
} from "../domain/evaluate.js";
import { contentHash, type Listing } from "../domain/listing.js";

export interface RecordedPoll {
  snapshotId: number;
  decision: PollDecision;
}

/** Everything the poller reads from and writes to the database. */
export class PollStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Takes the most overdue competitor off the queue, or returns null when none is due.
   *
   * Claiming pushes `next_poll_at` one interval ahead straight away. That acts as a
   * lease: if the worker dies mid-poll, the competitor is simply due again one interval
   * later and is never stuck. Scheduling from the claim time (not from the old due time)
   * also means an overloaded queue degrades into a fair round-robin instead of piling up.
   */
  async claimNextDue(pollIntervalSeconds: number): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [due] = await tx
        .select({ id: competitors.id })
        .from(competitors)
        .where(lte(competitors.nextPollAt, sql`now()`))
        .orderBy(asc(competitors.nextPollAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!due) {
        return null;
      }
      await tx
        .update(competitors)
        .set({ nextPollAt: sql`now() + make_interval(secs => ${pollIntervalSeconds})` })
        .where(eq(competitors.id, due.id));
      return due.id;
    });
  }

  /** Puts a competitor back at the head of the queue, after the source refused to answer. */
  async requeueAtFront(competitorId: string): Promise<void> {
    await this.db
      .update(competitors)
      .set({ nextPollAt: new Date(0) })
      .where(eq(competitors.id, competitorId));
  }

  /**
   * Stores one poll: the snapshot row and the competitor's new state, in one transaction,
   * so the two can never disagree. A change that needs the LLM is stored as a `pending`
   * summary; the poll result is safe before any LLM call is attempted.
   *
   * Returns null when the competitor was removed while the poll was in flight.
   */
  async recordPoll(
    competitorId: string,
    fetchedAt: Date,
    observation: Observation,
  ): Promise<RecordedPoll | null> {
    return this.db.transaction(async (tx) => {
      // Locking the row serialises polls of one competitor and waits out a concurrent delete.
      const [competitor] = await tx
        .select()
        .from(competitors)
        .where(eq(competitors.id, competitorId))
        .for("update");
      if (!competitor) {
        return null;
      }

      const { currentVersionId, previousVersionId } = competitor;
      const known = await loadListings(tx, [currentVersionId, previousVersionId]);
      const state: CompetitorState = {
        availability: competitor.availability,
        current: currentVersionId === null ? null : (known.get(currentVersionId) ?? null),
        previous: previousVersionId === null ? null : (known.get(previousVersionId) ?? null),
      };

      const decision = evaluatePoll(state, observation);

      // Version ids by content, so the new state can be written as ids again.
      const idByHash = new Map<string, number>();
      for (const [id, listing] of known) {
        idByHash.set(contentHash(listing), id);
      }
      let observedVersionId: number | null = null;
      if (observation.kind === "ok") {
        const hash = contentHash(observation.listing);
        // The usual case is "same as last time", which needs no write to listing_versions.
        observedVersionId =
          idByHash.get(hash) ??
          (await upsertVersion(tx, competitorId, hash, observation.listing, fetchedAt));
        idByHash.set(hash, observedVersionId);
      }
      const idOf = (listing: Listing | null): number | null =>
        listing === null ? null : (idByHash.get(contentHash(listing)) ?? null);

      const [snapshot] = await tx
        .insert(snapshots)
        .values({
          competitorId,
          fetchedAt,
          status: decision.status,
          failureReason: decision.failureReason,
          versionId: observedVersionId,
          // What the change was measured against, for showing and summarising it later.
          prevVersionId: decision.changed ? currentVersionId : null,
          changed: decision.changed,
          changeKind: decision.changeKind,
          ...summaryColumns(decision.summary, fetchedAt),
        })
        .returning({ id: snapshots.id });
      if (!snapshot) {
        throw new Error("Inserting the snapshot returned no row");
      }

      await tx
        .update(competitors)
        .set({
          availability: decision.next.availability,
          currentVersionId: idOf(decision.next.current),
          previousVersionId: idOf(decision.next.previous),
          lastPolledAt: fetchedAt,
          lastPollStatus: decision.status,
          ...(decision.changed ? { lastChangedAt: fetchedAt } : {}),
        })
        .where(eq(competitors.id, competitorId));

      return { snapshotId: snapshot.id, decision };
    });
  }

  /** Deletes snapshots past the retention period. Returns how many were removed. */
  async deleteSnapshotsOlderThan(days: number): Promise<number> {
    const result = await this.db
      .delete(snapshots)
      .where(lt(snapshots.fetchedAt, sql`now() - make_interval(days => ${days})`));
    return result.rowCount ?? 0;
  }
}

type SummaryColumns = Pick<
  NewSnapshotRow,
  "summary" | "summaryStatus" | "summarySource" | "summaryNextAttemptAt"
>;

function summaryColumns(plan: SummaryPlan, fetchedAt: Date): SummaryColumns {
  switch (plan.kind) {
    case "none":
      return { summaryStatus: "none" };
    case "template":
      return { summary: plan.text, summaryStatus: "done", summarySource: "template" };
    case "llm":
      // Queued for the summariser, due immediately.
      return { summaryStatus: "pending", summaryNextAttemptAt: fetchedAt };
  }
}

async function loadListings(tx: Tx, ids: (number | null)[]): Promise<Map<number, Listing>> {
  const wanted = ids.filter((id) => id !== null);
  const listings = new Map<number, Listing>();
  if (wanted.length === 0) {
    return listings;
  }
  const rows = await tx.select().from(listingVersions).where(inArray(listingVersions.id, wanted));
  for (const { id, title, tagline, price, description } of rows) {
    listings.set(id, { title, tagline, price, description });
  }
  return listings;
}

/** Stores a listing's content once per competitor and returns its id, new or existing. */
async function upsertVersion(
  tx: Tx,
  competitorId: string,
  hash: string,
  listing: Listing,
  firstSeenAt: Date,
): Promise<number> {
  const [row] = await tx
    .insert(listingVersions)
    .values({ competitorId, contentHash: hash, ...listing, firstSeenAt })
    .onConflictDoUpdate({
      target: [listingVersions.competitorId, listingVersions.contentHash],
      // A no-op update, so RETURNING also yields the id of a row that already existed.
      set: { contentHash: hash },
    })
    .returning({ id: listingVersions.id });
  if (!row) {
    throw new Error("Upserting the listing version returned no row");
  }
  return row.id;
}
