import { and, asc, desc, eq, gt, lte, min, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import {
  type CompetitorRow,
  competitors,
  listingVersions,
  llmUsage,
  snapshots,
} from "../db/schema.js";
import type { SnapshotWithVersions } from "./dto.js";

/** Everything the API reads from and writes to the database. */

export async function listCompetitors(
  db: Db,
): Promise<{ competitor: CompetitorRow; title: string | null }[]> {
  return db
    .select({ competitor: competitors, title: listingVersions.title })
    .from(competitors)
    .leftJoin(listingVersions, eq(listingVersions.id, competitors.currentVersionId))
    .orderBy(asc(competitors.id));
}

/**
 * Starts tracking a competitor. Returns null when it is already tracked.
 *
 * `next_poll_at` is set to the distant past, which puts it at the head of the poll queue:
 * a newly added competitor gets its first snapshot within about a second, even when the
 * queue is behind.
 */
export async function addCompetitor(db: Db, id: string): Promise<CompetitorRow | null> {
  const [row] = await db
    .insert(competitors)
    .values({ id, nextPollAt: new Date(0) })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Stops tracking a competitor and deletes its history. Returns false when it was not tracked. */
export async function removeCompetitor(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(competitors)
    .where(eq(competitors.id, id))
    .returning({ id: competitors.id });
  return deleted.length > 0;
}

export async function competitorExists(db: Db, id: string): Promise<boolean> {
  return (await db.$count(competitors, eq(competitors.id, id))) > 0;
}

export async function listSnapshots(
  db: Db,
  competitorId: string,
  options: { limit: number; changedOnly: boolean },
): Promise<SnapshotWithVersions[]> {
  const previous = alias(listingVersions, "previous_version");
  return db
    .select({ snapshot: snapshots, version: listingVersions, previous })
    .from(snapshots)
    .leftJoin(listingVersions, eq(listingVersions.id, snapshots.versionId))
    .leftJoin(previous, eq(previous.id, snapshots.prevVersionId))
    .where(
      and(
        eq(snapshots.competitorId, competitorId),
        options.changedOnly ? eq(snapshots.changed, true) : undefined,
      ),
    )
    .orderBy(desc(snapshots.fetchedAt), desc(snapshots.id))
    .limit(options.limit);
}

export interface QueueCounts {
  competitors: number;
  /** Competitors whose next poll time has passed. */
  overdue: number;
  /** How far behind schedule the most overdue competitor is, or null when none is. */
  oldestOverdueSeconds: number | null;
  pendingSummaries: number;
  llmCallsToday: number;
}

export async function getQueueCounts(db: Db, now: Date): Promise<QueueCounts> {
  const [total, overdue, oldest, pendingSummaries, usage] = await Promise.all([
    db.$count(competitors),
    db.$count(competitors, lte(competitors.nextPollAt, now)),
    // Skips the "distant past" marker used to put a competitor at the head of the queue.
    db
      .select({ nextPollAt: min(competitors.nextPollAt) })
      .from(competitors)
      .where(and(lte(competitors.nextPollAt, now), gt(competitors.nextPollAt, new Date(0)))),
    db.$count(snapshots, eq(snapshots.summaryStatus, "pending")),
    db
      .select({ calls: llmUsage.calls })
      .from(llmUsage)
      .where(eq(llmUsage.day, sql`(now() AT TIME ZONE 'utc')::date`)),
  ]);

  const oldestDue = oldest[0]?.nextPollAt ?? null;
  return {
    competitors: total,
    overdue,
    oldestOverdueSeconds:
      oldestDue === null ? null : Math.round((now.getTime() - oldestDue.getTime()) / 1000),
    pendingSummaries,
    llmCallsToday: usage[0]?.calls ?? 0,
  };
}
