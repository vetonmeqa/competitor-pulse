import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  lte,
  min,
  or,
  sql,
} from "drizzle-orm";
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
  /** How many competitors match the search and the filter. */
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
 * the text, in any letter case. An empty search keeps all. `activeOnly` leaves out the
 * paused ones.
 *
 * A page past the end gives the last page. That happens in normal use, for example when
 * the only competitor on the last page is removed, and the caller then needs no second
 * request.
 */
export async function listCompetitors(
  db: Db,
  options: { page: number; pageSize: number; search: string; activeOnly: boolean },
): Promise<CompetitorPage> {
  const pattern = `%${escapeLike(options.search)}%`;
  // Undefined when there is nothing to filter on, which keeps every competitor.
  const matches = and(
    options.search === ""
      ? undefined
      : or(ilike(competitors.id, pattern), ilike(listingVersions.title, pattern)),
    options.activeOnly ? isNull(competitors.pausedAt) : undefined,
  );
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

/**
 * Pauses the tracking of a competitor: it keeps its history and is no longer polled.
 * Returns false when it is not tracked. Pausing one that is already paused changes
 * nothing, so the time it was first paused is kept.
 */
export async function pauseCompetitor(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(competitors)
    .set({ pausedAt: sql`coalesce(${competitors.pausedAt}, now())` })
    .where(eq(competitors.id, id))
    .returning({ id: competitors.id });
  return updated.length > 0;
}

/**
 * Resumes the tracking of a paused competitor and puts it at the head of the poll queue,
 * so it is polled again within about a second. Returns false when it is not tracked.
 * Resuming one that is not paused changes nothing: it keeps its place in the queue.
 */
export async function resumeCompetitor(db: Db, id: string): Promise<boolean> {
  // The column names on the right of a SET are the values before the update.
  const updated = await db
    .update(competitors)
    .set({
      pausedAt: null,
      nextPollAt: sql`case when ${competitors.pausedAt} is null then ${competitors.nextPollAt} else to_timestamp(0) end`,
    })
    .where(eq(competitors.id, id))
    .returning({ id: competitors.id });
  return updated.length > 0;
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

/**
 * A competitor's snapshots, newest first.
 *
 * `before` is the id of a snapshot of this competitor and returns only the snapshots
 * older than it. The caller pages through the history by passing the id of the last
 * snapshot it has: each request reads only its own rows, however far back it is, and
 * polls that arrive meanwhile do not shift anything. An id that does not exist (any more)
 * returns nothing.
 */
export async function listSnapshots(
  db: Db,
  competitorId: string,
  options: { limit: number; changedOnly: boolean; before?: number | undefined },
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
        options.before === undefined ? undefined : olderThan(db, competitorId, options.before),
      ),
    )
    .orderBy(desc(snapshots.fetchedAt), desc(snapshots.id))
    .limit(options.limit);
}

/**
 * "Older than snapshot `cursorId`", in the order of the timeline: by time, then by id.
 * Comparing the pair (time, id) as one value is what lets PostgreSQL jump straight to the
 * position in the timeline index instead of reading the newer rows first.
 */
function olderThan(db: Db, competitorId: string, cursorId: number) {
  const cursor = alias(snapshots, "cursor_snapshot");
  const cursorTime = db
    .select({ fetchedAt: cursor.fetchedAt })
    .from(cursor)
    .where(and(eq(cursor.id, cursorId), eq(cursor.competitorId, competitorId)));
  return sql`(${snapshots.fetchedAt}, ${snapshots.id}) < ((${cursorTime}), ${cursorId})`;
}

export interface QueueCounts {
  competitors: number;
  /** Competitors whose tracking is paused. They are not polled and never overdue. */
  paused: number;
  /** Competitors whose next poll time has passed. */
  overdue: number;
  /** How far behind schedule the most overdue competitor is, or null when none is. */
  oldestOverdueSeconds: number | null;
  pendingSummaries: number;
  llmCallsToday: number;
}

export async function getQueueCounts(db: Db, now: Date): Promise<QueueCounts> {
  const active = isNull(competitors.pausedAt);
  const [total, paused, overdue, oldest, pendingSummaries, usage] = await Promise.all([
    db.$count(competitors),
    db.$count(competitors, isNotNull(competitors.pausedAt)),
    db.$count(competitors, and(active, lte(competitors.nextPollAt, now))),
    // Skips the "distant past" marker used to put a competitor at the head of the queue.
    db
      .select({ nextPollAt: min(competitors.nextPollAt) })
      .from(competitors)
      .where(
        and(active, lte(competitors.nextPollAt, now), gt(competitors.nextPollAt, new Date(0))),
      ),
    db.$count(snapshots, eq(snapshots.summaryStatus, "pending")),
    db
      .select({ calls: llmUsage.calls })
      .from(llmUsage)
      .where(eq(llmUsage.day, sql`(now() AT TIME ZONE 'utc')::date`)),
  ]);

  const oldestDue = oldest[0]?.nextPollAt ?? null;
  return {
    competitors: total,
    paused,
    overdue,
    oldestOverdueSeconds:
      oldestDue === null ? null : Math.round((now.getTime() - oldestDue.getTime()) / 1000),
    pendingSummaries,
    llmCallsToday: usage[0]?.calls ?? 0,
  };
}
