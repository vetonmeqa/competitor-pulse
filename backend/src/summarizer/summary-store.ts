import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { listingVersions, snapshots } from "../db/schema.js";
import type { SummaryError } from "../domain/summary.js";
import type { SummaryJob } from "./prompt.js";

const isPending = eq(snapshots.summaryStatus, "pending");
const isDue = and(isPending, lte(snapshots.summaryNextAttemptAt, sql`now()`));
/** The LLM's last answer for this change was unusable, so it is retried on its own. */
const RETRY_ALONE: SummaryError = "llm_invalid_response";

/**
 * The summary queue. There is no separate queue table: a snapshot whose summary is
 * `pending` is the job, so a change and its summary request are stored in one write.
 */
export class SummaryStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Takes the pending summaries for one LLM call: a single change, or a batch of up to
   * `maxBatchSize`. Newest change first, because a fresh change is worth more than an
   * old one when the budget is short.
   *
   * A change whose last answer was unusable is always returned alone. In a batch, one
   * confusing item could keep spoiling the answers for the others; alone, it is sent in
   * the simpler single-change form.
   *
   * Claiming counts as an attempt and pushes the next attempt `leaseSeconds` ahead. If
   * the worker dies mid-call, the jobs simply become due again when the lease runs out.
   */
  async claim(maxBatchSize: number, leaseSeconds: number): Promise<SummaryJob[]> {
    return this.db.transaction(async (tx) => {
      const [newest] = await tx
        .select({ id: snapshots.id, lastError: snapshots.summaryError })
        .from(snapshots)
        .where(isDue)
        .orderBy(desc(snapshots.fetchedAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!newest) {
        return [];
      }
      const ids = [newest.id];

      if (maxBatchSize > 1 && newest.lastError !== RETRY_ALONE) {
        const more = await tx
          .select({ id: snapshots.id })
          .from(snapshots)
          .where(
            and(
              isDue,
              ne(snapshots.id, newest.id),
              or(isNull(snapshots.summaryError), ne(snapshots.summaryError, RETRY_ALONE)),
            ),
          )
          .orderBy(desc(snapshots.fetchedAt))
          .limit(maxBatchSize - 1)
          .for("update", { skipLocked: true });
        ids.push(...more.map((row) => row.id));
      }

      await tx
        .update(snapshots)
        .set({
          summaryAttempts: sql`${snapshots.summaryAttempts} + 1`,
          summaryNextAttemptAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
        })
        .where(inArray(snapshots.id, ids));

      const previous = alias(listingVersions, "previous_version");
      const rows = await tx
        .select({ snapshot: snapshots, after: listingVersions, before: previous })
        .from(snapshots)
        .leftJoin(listingVersions, eq(listingVersions.id, snapshots.versionId))
        .leftJoin(previous, eq(previous.id, snapshots.prevVersionId))
        .where(inArray(snapshots.id, ids))
        .orderBy(desc(snapshots.fetchedAt));

      const jobs: SummaryJob[] = [];
      for (const { snapshot, before, after } of rows) {
        if (before === null || after === null) {
          // Cannot happen for a row the poller wrote, but never send half a diff to the LLM.
          await tx
            .update(snapshots)
            .set({ summaryStatus: "failed", summaryError: "llm_error", summaryNextAttemptAt: null })
            .where(eq(snapshots.id, snapshot.id));
          continue;
        }
        jobs.push({
          snapshotId: snapshot.id,
          competitorId: snapshot.competitorId,
          changeKind: snapshot.changeKind,
          attempt: snapshot.summaryAttempts,
          before: pickListing(before),
          after: pickListing(after),
        });
      }
      return jobs;
    });
  }

  async saveSummary(snapshotId: number, summary: string): Promise<void> {
    await this.db
      .update(snapshots)
      .set({
        summary,
        summaryStatus: "done",
        summarySource: "llm",
        summaryError: null,
        summaryNextAttemptAt: null,
      })
      // Still pending: it may have expired or been removed while the LLM was working.
      .where(and(eq(snapshots.id, snapshotId), isPending));
  }

  /** Keeps the job pending and schedules another attempt. */
  async retryLater(snapshotId: number, error: SummaryError, delaySeconds: number): Promise<void> {
    await this.db
      .update(snapshots)
      .set({
        summaryError: error,
        summaryNextAttemptAt: sql`now() + make_interval(secs => ${delaySeconds})`,
      })
      .where(and(eq(snapshots.id, snapshotId), isPending));
  }

  /** Gives up on the job. The snapshot and its field-by-field changes remain. */
  async markFailed(snapshotId: number, error: SummaryError): Promise<void> {
    await this.db
      .update(snapshots)
      .set({ summaryStatus: "failed", summaryError: error, summaryNextAttemptAt: null })
      .where(and(eq(snapshots.id, snapshotId), isPending));
  }

  /** Undoes a claim whose LLM call was never completed, e.g. because of a shutdown. */
  async release(snapshotIds: number[]): Promise<void> {
    await this.db
      .update(snapshots)
      .set({
        summaryAttempts: sql`greatest(${snapshots.summaryAttempts} - 1, 0)`,
        summaryNextAttemptAt: sql`now()`,
      })
      .where(and(inArray(snapshots.id, snapshotIds), isPending));
  }

  /**
   * The daily cap is reached. Undoes the claim (no call was made) and parks every pending
   * summary until the budget resets, with a reason the user can see.
   */
  async deferForCap(claimedSnapshotIds: number[], until: Date): Promise<void> {
    await this.db
      .update(snapshots)
      .set({
        summaryAttempts: sql`greatest(${snapshots.summaryAttempts} - 1, 0)`,
        summaryError: "daily_cap_reached",
        summaryNextAttemptAt: until,
      })
      .where(and(inArray(snapshots.id, claimedSnapshotIds), isPending));
    await this.db
      .update(snapshots)
      .set({ summaryError: "daily_cap_reached", summaryNextAttemptAt: until })
      .where(inArray(snapshots.id, this.unlockedPending(lt(snapshots.summaryNextAttemptAt, until))));
  }

  /** While the LLM is down: tells the user why the pending summaries are waiting. */
  async flagLlmUnavailable(): Promise<void> {
    const notYetExplained = or(
      isNull(snapshots.summaryError),
      notInArray(snapshots.summaryError, ["llm_unavailable", "daily_cap_reached"]),
    );
    await this.db
      .update(snapshots)
      .set({ summaryError: "llm_unavailable" })
      .where(inArray(snapshots.id, this.unlockedPending(notYetExplained)));
  }

  /** The LLM is back: the waiting summaries are simply "being generated" again. */
  async clearLlmUnavailable(): Promise<void> {
    await this.db
      .update(snapshots)
      .set({ summaryError: null })
      .where(
        inArray(snapshots.id, this.unlockedPending(eq(snapshots.summaryError, "llm_unavailable"))),
      );
  }

  /**
   * Gives up on changes that nobody could summarise while they were recent. Without
   * this, a backlog that outgrows the daily cap would grow forever. Returns the count.
   */
  async expireOlderThan(hours: number): Promise<number> {
    const tooOld = lt(snapshots.fetchedAt, sql`now() - make_interval(hours => ${hours})`);
    const result = await this.db
      .update(snapshots)
      .set({ summaryStatus: "failed", summaryError: "expired", summaryNextAttemptAt: null })
      .where(inArray(snapshots.id, this.unlockedPending(tooOld)));
    return result.rowCount ?? 0;
  }

  /**
   * The ids of pending summaries that match `condition` and that no other transaction is
   * holding right now. Every update that touches many queue rows selects them this way.
   *
   * Several workers update the queue at once. If two multi-row updates each waited for
   * rows the other had locked, Postgres would detect a deadlock and abort one of them.
   * Skipping locked rows means these updates never wait, so they cannot deadlock. A
   * skipped row is being handled by whoever holds it, or is picked up on the next pass.
   */
  private unlockedPending(condition: SQL | undefined) {
    return this.db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(and(isPending, condition))
      .for("update", { skipLocked: true });
  }
}

function pickListing(row: typeof listingVersions.$inferSelect) {
  const { title, tagline, price, description } = row;
  return { title, tagline, price, description };
}
