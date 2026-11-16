import { createHash } from "node:crypto";
import { decodeHTMLStrict } from "entities";
import { normalizePrice } from "./price.js";

/** The only fields of a source response that we track. Everything else is noise. */
export const LISTING_FIELDS = ["title", "tagline", "price", "description"] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];

/** A listing after normalisation. Two listings that mean the same thing are equal field by field. */
export type Listing = Readonly<Record<ListingField, string>>;

export type ParsedListing =
  | { kind: "ok"; listing: Listing }
  /** A valid response, but at least one tracked field is absent, null, empty or not a string. */
  | { kind: "incomplete"; missing: ListingField[] }
  /** Not a JSON object at all. */
  | { kind: "invalid" };

/**
 * Removes presentation differences from a text field: HTML entities (`&amp;`, `&nbsp;`),
 * runs of whitespace, and leading or trailing whitespace. `\s` also matches a
 * non-breaking space, so a decoded `&nbsp;` becomes a normal space.
 */
export function normalizeText(raw: string): string {
  return decodeHTMLStrict(raw).normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Turns a raw source response into a normalised listing, or says why it cannot. */
export function parseListing(raw: unknown): ParsedListing {
  if (!isRecord(raw)) {
    return { kind: "invalid" };
  }

  // A field that is absent, null, not a string or blank reads as "".
  const read = (field: ListingField): string => {
    const value = raw[field];
    return typeof value === "string" ? normalizeText(value) : "";
  };
  const values = {
    title: read("title"),
    tagline: read("tagline"),
    price: read("price"),
    description: read("description"),
  };

  const missing = LISTING_FIELDS.filter((field) => values[field] === "");
  if (missing.length > 0) {
    return { kind: "incomplete", missing };
  }
  return { kind: "ok", listing: { ...values, price: normalizePrice(values.price) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names the fields whose normalised values differ. */
export function diffFields(before: Listing, after: Listing): ListingField[] {
  return LISTING_FIELDS.filter((field) => before[field] !== after[field]);
}

export function sameListing(a: Listing, b: Listing): boolean {
  return diffFields(a, b).length === 0;
}

/** Stable identity of a listing's content, used to store each distinct version once. */
export function contentHash(listing: Listing): string {
  const canonical = JSON.stringify(LISTING_FIELDS.map((field) => listing[field]));
  return createHash("sha256").update(canonical).digest("hex");
}
