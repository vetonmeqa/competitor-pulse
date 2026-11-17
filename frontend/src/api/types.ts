/**
 * The shapes the backend returns. They mirror backend/src/api/dto.ts; dates arrive as
 * ISO 8601 strings.
 */

export type Availability = "unknown" | "listed" | "delisted";
export type PollStatus = "ok" | "not_found" | "incomplete" | "error";
export type ChangeKind = "initial" | "content" | "revert" | "delisted" | "relisted";
export type SummaryStatus = "none" | "pending" | "done" | "failed";
export type ListingField = "title" | "tagline" | "price" | "description";

export interface Competitor {
  id: string;
  createdAt: string;
  /** `unknown` until the source has returned a listing at least once. */
  availability: Availability;
  /** Title of the last listing seen, if any. */
  title: string | null;
  lastPolledAt: string | null;
  lastPollStatus: PollStatus | null;
  lastChangedAt: string | null;
  changedInLast24h: boolean;
  /** When tracking was paused, or null while the competitor is being polled. */
  pausedAt: string | null;
}

/**
 * One page of the competitor list, with the counts the pager needs. The API sends the
 * items as the response body and the counts as headers; the client puts them together.
 */
export interface CompetitorPage {
  items: Competitor[];
  /** The page returned. Lower than the page asked for when that one is past the end. */
  page: number;
  pageSize: number;
  /** How many competitors match the search and the filter. */
  total: number;
  /** How many competitors are tracked in all. */
  totalTracked: number;
}

export interface Change {
  field: ListingField;
  before: string;
  after: string;
}

export interface SummaryReason {
  code: string;
  message: string;
}

export interface Snapshot {
  id: number;
  fetchedAt: string;
  /** Outcome of the poll. The listing fields are null unless this is `ok`. */
  status: PollStatus;
  statusDetail: string | null;
  title: string | null;
  tagline: string | null;
  price: string | null;
  description: string | null;
  changed: boolean;
  changeKind: ChangeKind | null;
  /** What changed, field by field. Present whether or not there is a summary. */
  changes: Change[];
  summary: string | null;
  summaryStatus: SummaryStatus;
  summarySource: "llm" | "template" | null;
  /** Present exactly when `summary` is null: why there is no summary. */
  summaryReason: SummaryReason | null;
}

export interface SystemStatus {
  now: string;
  polling: {
    competitors: number;
    /** Competitors whose tracking is paused. */
    paused: number;
    intervalSeconds: number;
    overdue: number;
    oldestOverdueSeconds: number | null;
  };
  summaries: {
    pending: number;
    llmCallsToday: number;
    llmDailyCap: number;
  };
  /** Null when no worker has ever run. */
  worker: {
    running: boolean;
    lastSeenAt: string;
    poller: {
      rateLimiter: {
        maxRatePerSecond: number;
        currentRatePerSecond: number;
        rateLimitedCount: number;
      };
    };
    summarizer: {
      provider: string;
      breaker: { state: "closed" | "open" | "half_open" };
    };
  } | null;
}
