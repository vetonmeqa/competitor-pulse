import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Whether the source currently lists the competitor. `unknown` = never seen yet. */
export const availability = pgEnum("availability", ["unknown", "listed", "delisted"]);

/** Outcome of one poll of the source. */
export const pollStatus = pgEnum("poll_status", ["ok", "not_found", "incomplete", "error"]);

/** Why a snapshot is (or is not) a change. `initial` is the first good listing: a baseline, not a change. */
export const changeKind = pgEnum("change_kind", [
  "initial",
  "content",
  "revert",
  "delisted",
  "relisted",
]);

/** `none` = no summary is needed; `pending` = waiting for the LLM (first try, retry, or cap reset). */
export const summaryStatus = pgEnum("summary_status", ["none", "pending", "done", "failed"]);

export const summarySource = pgEnum("summary_source", ["llm", "template"]);

export const competitors = pgTable(
  "competitors",
  {
    id: text("id").primaryKey(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),

    // The schedule. The poller always takes the row with the oldest next_poll_at.
    nextPollAt: timestamptz("next_poll_at").notNull().defaultNow(),
    // Set while tracking is paused. A paused competitor keeps its history and is not polled.
    pausedAt: timestamptz("paused_at"),

    // Current state, which every new poll is compared against.
    availability: availability("availability").notNull().default("unknown"),
    // Last listing seen. Kept while delisted, so a relisting can be compared with it.
    currentVersionId: bigint("current_version_id", { mode: "number" }).references(
      (): AnyPgColumn => listingVersions.id,
    ),
    // Listing before the last content change. Lets us recognise a revert (A -> B -> A).
    previousVersionId: bigint("previous_version_id", { mode: "number" }).references(
      (): AnyPgColumn => listingVersions.id,
    ),

    // Denormalised for the list view, so it never has to scan snapshots.
    lastPolledAt: timestamptz("last_polled_at"),
    lastPollStatus: pollStatus("last_poll_status"),
    lastChangedAt: timestamptz("last_changed_at"),
  },
  (t) => [
    // The poll queue. Paused competitors are left out of it, so the poller never has to
    // read past them to find the next one that is due.
    index("competitors_next_poll_at_idx")
      .on(t.nextPollAt)
      .where(sql`${t.pausedAt} IS NULL`),
  ],
);

/**
 * Distinct listing contents per competitor, already normalised. A poll that finds
 * nothing new points at an existing row instead of storing the text again.
 */
export const listingVersions = pgTable(
  "listing_versions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    title: text("title").notNull(),
    tagline: text("tagline").notNull(),
    price: text("price").notNull(),
    description: text("description").notNull(),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("listing_versions_competitor_hash_uq").on(t.competitorId, t.contentHash)],
);

/** One row per poll, including polls that failed and polls where nothing changed. */
export const snapshots = pgTable(
  "snapshots",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    competitorId: text("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    fetchedAt: timestamptz("fetched_at").notNull(),

    status: pollStatus("status").notNull(),
    // Detail for a poll that is not `ok`, e.g. "timeout", "http_503", "missing:price".
    failureReason: text("failure_reason"),

    // The listing this poll saw (null unless status is `ok`).
    versionId: bigint("version_id", { mode: "number" }).references(() => listingVersions.id),
    // The listing it was compared against, kept so the change can be shown and summarised later.
    prevVersionId: bigint("prev_version_id", { mode: "number" }).references(
      () => listingVersions.id,
    ),

    changed: boolean("changed").notNull().default(false),
    changeKind: changeKind("change_kind"),

    // The snapshot row is also the summary job: `pending` rows are the queue.
    summary: text("summary"),
    summaryStatus: summaryStatus("summary_status").notNull().default("none"),
    summarySource: summarySource("summary_source"),
    // Machine-readable reason for the last failed or deferred attempt.
    summaryError: text("summary_error"),
    summaryAttempts: integer("summary_attempts").notNull().default(0),
    summaryNextAttemptAt: timestamptz("summary_next_attempt_at"),
  },
  (t) => [
    // Timeline: one competitor, newest first (read backwards).
    index("snapshots_competitor_fetched_idx").on(t.competitorId, t.fetchedAt, t.id),
    // Summary queue: only the few pending rows are indexed.
    index("snapshots_pending_summary_idx")
      .on(t.fetchedAt)
      .where(sql`${t.summaryStatus} = 'pending'`),
    // Retention delete by age. Rows arrive in time order, so a tiny BRIN index is enough.
    index("snapshots_fetched_at_brin").using("brin", t.fetchedAt),
  ],
);

/** LLM calls made per UTC day, for the hard daily cap. */
export const llmUsage = pgTable("llm_usage", {
  day: date("day", { mode: "string" }).primaryKey(),
  calls: integer("calls").notNull().default(0),
});

/**
 * The worker's latest self-report, so the API (a separate process) can show it. One row
 * only. The content is validated when read, in src/worker-status.ts.
 */
export const workerStatus = pgTable(
  "worker_status",
  {
    id: integer("id").primaryKey().default(1),
    updatedAt: timestamptz("updated_at").notNull(),
    report: jsonb("report").$type<unknown>().notNull(),
  },
  (t) => [check("worker_status_single_row", sql`${t.id} = 1`)],
);

export type CompetitorRow = typeof competitors.$inferSelect;
export type ListingVersionRow = typeof listingVersions.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type NewSnapshotRow = typeof snapshots.$inferInsert;
