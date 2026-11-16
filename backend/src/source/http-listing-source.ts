import { parseListing } from "../domain/listing.js";
import type { FetchResult, ListingSource } from "./listing-source.js";

export interface HttpListingSourceOptions {
  baseUrl: string;
  /** Budget for the whole request: connecting, waiting, and reading the body. */
  timeoutMs: number;
}

/** Used when a 429 has no usable Retry-After header. */
const DEFAULT_RETRY_AFTER_MS = 1000;

/**
 * Reads listings from the source over HTTP, treating it as an unreliable third-party
 * website: every way a request can go wrong becomes a typed result.
 */
export class HttpListingSource implements ListingSource {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: HttpListingSourceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
  }

  async fetchListing(id: string): Promise<FetchResult> {
    const url = `${this.baseUrl}/listings/${encodeURIComponent(id)}`;
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        // Also aborts a body that stalls after the headers arrived.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return await this.toResult(response);
    } catch (error) {
      return { kind: "error", reason: isTimeout(error) ? "timeout" : "network" };
    }
  }

  private async toResult(response: Response): Promise<FetchResult> {
    if (response.status === 200) {
      return toListingResult(await readJson(response));
    }

    // We do not need the body of any other response. Discard it so the connection is freed.
    await response.body?.cancel();

    if (response.status === 429) {
      return {
        kind: "rate_limited",
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    if (response.status === 404) {
      return { kind: "not_found" };
    }
    return { kind: "error", reason: `http_${response.status}` };
  }
}

function toListingResult(body: unknown): FetchResult {
  const parsed = parseListing(body);
  switch (parsed.kind) {
    case "ok":
      return { kind: "ok", listing: parsed.listing };
    case "incomplete":
      return { kind: "incomplete", missing: parsed.missing };
    case "invalid":
      return { kind: "error", reason: "invalid_body" };
  }
}

/** Returns `undefined` for a body that is not JSON, which `parseListing` reports as invalid. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads a Retry-After header, which is either a number of seconds or an HTTP date.
 * Falls back to a short default when the header is missing or unreadable.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number {
  if (header === null || header.trim() === "") {
    return DEFAULT_RETRY_AFTER_MS;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  return Math.max(0, date - now);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
