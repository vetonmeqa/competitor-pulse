import { and, asc, count, desc, eq, gt, ilike, lte, min, or, sql } from "drizzle-orm";
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

export interface CompetitorWithTitle {
  competitor: CompetitorRow;
  /** Title of the last listing seen, if any. */
  title: string | null;
}

export interface CompetitorPage {
  rows: CompetitorWithTitle[];
  /** How many competitors match the search. Equal to `totalTracked` without a search. */
  total: number;
  /** How many competitors are tracked in all. */
  totalTracked: number;
  /** The page returned. Lower than the page asked for when that one is past the end. */
  page: number;
}

/** Makes the `%`, `_` and `\` in a search text match themselves in a LIKE pattern. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, "\\$&");

/**
 * One page of competitors, by id. `search` keeps those whose id or current title contains
 * the text, in any letter case. An empty search keeps all.
 *
 * A page past the end gives the last page. That happens in normal use, for example when
 * the only competitor on the last page is removed, and the caller then needs no second
 * request.
 */
export async function listCompetitors(
  db: Db,
  options: { page: number; pageSize: number; search: string },
): Promise<CompetitorPage> {
  const pattern = `%${escapeLike(options.search)}%`;
  const matches =
    options.search === ""
      ? undefined
      : or(ilike(competitors.id, pattern), ilike(listingVersions.title, pattern));
  const currentVersion = eq(listingVersions.id, competitors.currentVersionId);

  const [totalTracked, matching] = await Promise.all([
    db.$count(competitors),
    matches === undefined
      ? null
      : db
          .select({ total: count() })
          .from(competitors)
          .leftJoin(listingVersions, currentVersion)
          .where(matches),
  ]);
  const total = matching === null ? totalTracked : (matching[0]?.total ?? 0);
  const lastPage = Math.max(1, Math.ceil(total / options.pageSize));
  const page = Math.min(options.page, lastPage);

  const rows = await db
    .select({ competitor: competitors, title: listingVersions.title })
    .from(competitors)
    .leftJoin(listingVersions, currentVersion)
    .where(matches)
    .orderBy(asc(competitors.id))
    .limit(options.pageSize)
    .offset((page - 1) * options.pageSize);

  return { rows, total, totalTracked, page };
}

/** One competitor with its current title, or null when it is not tracked. */
export async function getCompetitor(db: Db, id: string): Promise<CompetitorWithTitle | null> {
  const [row] = await db
    .select({ competitor: competitors, title: listingVersions.title })
    .from(competitors)
    .leftJoin(listingVersions, eq(listingVersions.id, competitors.currentVersionId))
    .where(eq(competitors.id, id));
  return row ?? null;
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
