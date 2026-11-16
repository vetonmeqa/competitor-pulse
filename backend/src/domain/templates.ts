import type { Listing, ListingField } from "./listing.js";

/**
 * Summaries for changes that a fixed sentence describes exactly. They need no LLM call,
 * so they cost nothing against the daily cap and can never fail.
 */

const MAX_QUOTE_LENGTH = 80;

function quote(value: string): string {
  const text =
    value.length > MAX_QUOTE_LENGTH ? `${value.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…` : value;
  return `"${text}"`;
}

export function delistedSummary(lastSeen: Listing | null): string {
  const base = "The listing is no longer available at the source.";
  return lastSeen
    ? `${base} It was last seen as ${quote(lastSeen.title)} at ${lastSeen.price}.`
    : base;
}

export function relistedUnchangedSummary(): string {
  return "The listing is available again, with the same content as before it disappeared.";
}

/** `before` is the version being left; `after` is the earlier version that came back. */
export function revertSummary(before: Listing, after: Listing, fields: ListingField[]): string {
  const parts = fields.map(
    (field) => `${field} is back to ${quote(after[field])} (was ${quote(before[field])})`,
  );
  return `Reverted to the previous version: ${parts.join("; ")}. This may be an A/B test or a rollback.`;
}
