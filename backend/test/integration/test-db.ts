import { asc, eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import {
  type CompetitorRow,
  competitors,
  listingVersions,
  type SnapshotRow,
  snapshots,
} from "../../src/db/schema.js";
import type { Listing } from "../../src/domain/listing.js";

/** A separate database, so the tests never touch development data. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://pulse:pulse@localhost:5432/pulse_test";

export function openTestDb() {
  return createDb(TEST_DATABASE_URL);
}

export async function resetTables(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE competitors, listing_versions, snapshots, llm_usage RESTART IDENTITY CASCADE`,
  );
}

/** Adds a competitor. By default it is due immediately. */
export async function addCompetitor(db: Db, id: string, nextPollAt = new Date(0)): Promise<void> {
  await db.insert(competitors).values({ id, nextPollAt });
}

export async function getCompetitor(db: Db, id: string): Promise<CompetitorRow> {
  const [row] = await db.select().from(competitors).where(eq(competitors.id, id));
  if (!row) {
    throw new Error(`competitor ${id} not found`);
  }
  return row;
}

/** A competitor's snapshots, oldest first. */
export async function snapshotsOf(db: Db, id: string): Promise<SnapshotRow[]> {
  return db
    .select()
    .from(snapshots)
    .where(eq(snapshots.competitorId, id))
    .orderBy(asc(snapshots.id));
}

export async function versionCount(db: Db, id: string): Promise<number> {
  return db.$count(listingVersions, eq(listingVersions.competitorId, id));
}

export const A: Listing = {
  title: "Acme CRM",
  tagline: "Simple CRM for small teams",
  price: "$39/mo",
  description: "Track leads & deals in one place.",
};
export const B: Listing = { ...A, tagline: "The CRM small teams love" };
export const C: Listing = { ...B, price: "$29/mo" };

/** Minutes ago, as a Date. */
export const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

/** Polls `check` until it returns true, or fails after `timeoutMs`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
