import type { CompetitorRow, ListingVersionRow, SnapshotRow } from "../db/schema.js";
import { diffFields, type Listing, type ListingField } from "../domain/listing.js";
import type { WorkerReport } from "../worker-status.js";
import { explainMissingSummary, type SummaryReason } from "./summary-reason.js";

/** The shapes the API returns. Dates are ISO 8601 strings in the JSON. */

export interface CompetitorDto {
  id: string;
  createdAt: Date;
  /** `unknown` until the source has returned a listing at least once. */
  availability: CompetitorRow["availability"];
  /** Title of the last listing seen, if any. */
  title: string | null;
  lastPolledAt: Date | null;
  lastPollStatus: CompetitorRow["lastPollStatus"];
  lastChangedAt: Date | null;
  changedInLast24h: boolean;
  /** When tracking was paused, or null while the competitor is being polled. */
  pausedAt: Date | null;
}

export interface ChangeDto {
  field: ListingField;
  before: string;
  after: string;
}

export interface SnapshotDto {
  id: number;
  fetchedAt: Date;
  /** Outcome of the poll. The listing fields are null unless this is `ok`. */
  status: SnapshotRow["status"];
  /** Machine-readable detail for a poll that is not `ok`, e.g. "timeout" or "missing:price". */
  statusDetail: string | null;
  title: string | null;
  tagline: string | null;
  price: string | null;
  description: string | null;
  changed: boolean;
  changeKind: SnapshotRow["changeKind"];
  /** What changed, field by field. Never depends on the LLM. */
  changes: ChangeDto[];
  summary: string | null;
  summaryStatus: SnapshotRow["summaryStatus"];
  summarySource: SnapshotRow["summarySource"];
  /** Present exactly when `summary` is null: why there is no summary. */
  summaryReason: SummaryReason | null;
}

export interface StatusDto {
  now: Date;
  polling: {
    competitors: number;
    /** Competitors whose tracking is paused. They are not polled and never overdue. */
    paused: number;
    intervalSeconds: number;
    /** Competitors whose next poll time has passed. */
    overdue: number;
    /** How far behind schedule the most overdue competitor is, or null when none is. */
    oldestOverdueSeconds: number | null;
  };
  summaries: {
    pending: number;
    llmCallsToday: number;
    llmDailyCap: number;
  };
  /** The worker's own report, or null when no worker has ever run. */
  worker: (WorkerReport & { running: boolean; lastSeenAt: Date }) | null;
}

const ONE_DAY_MS = 24 * 60 * 60_000;

export function toCompetitorDto(
  competitor: CompetitorRow,
  title: string | null,
  now: Date,
): CompetitorDto {
  const { lastChangedAt } = competitor;
  return {
    id: competitor.id,
    createdAt: competitor.createdAt,
    availability: competitor.availability,
    title,
    lastPolledAt: competitor.lastPolledAt,
    lastPollStatus: competitor.lastPollStatus,
    lastChangedAt,
    changedInLast24h:
      lastChangedAt !== null && now.getTime() - lastChangedAt.getTime() < ONE_DAY_MS,
    pausedAt: competitor.pausedAt,
  };
}

export interface SnapshotWithVersions {
  snapshot: SnapshotRow;
  /** The listing this poll saw. */
  version: ListingVersionRow | null;
  /** The listing it was compared against, when it is a change. */
  previous: ListingVersionRow | null;
}

export function toSnapshotDto({ snapshot, version, previous }: SnapshotWithVersions): SnapshotDto {
  return {
    id: snapshot.id,
    fetchedAt: snapshot.fetchedAt,
    status: snapshot.status,
    statusDetail: snapshot.failureReason,
    title: version?.title ?? null,
    tagline: version?.tagline ?? null,
    price: version?.price ?? null,
    description: version?.description ?? null,
    changed: snapshot.changed,
    changeKind: snapshot.changeKind,
    changes: version && previous ? toChanges(previous, version) : [],
    summary: snapshot.summary,
    summaryStatus: snapshot.summaryStatus,
    summarySource: snapshot.summarySource,
    summaryReason: explainMissingSummary(snapshot),
  };
}

function toChanges(before: Listing, after: Listing): ChangeDto[] {
  return diffFields(before, after).map((field) => ({
    field,
    before: before[field],
    after: after[field],
  }));
}
