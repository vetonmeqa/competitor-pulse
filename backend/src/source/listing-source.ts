import type { Observation } from "../domain/evaluate.js";

/**
 * The result of asking the source for one listing.
 *
 * `rate_limited` is kept apart from `Observation` on purpose: the source refused to
 * answer, so we learned nothing about the competitor. It is back-pressure for the
 * scheduler, not a poll result to record.
 */
export type FetchResult = Observation | { kind: "rate_limited"; retryAfterMs: number };

/** Where listings come from. The poller only knows this interface. */
export interface ListingSource {
  /** Never throws: every failure is returned as a result. */
  fetchListing(id: string): Promise<FetchResult>;
}
