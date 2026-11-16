import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpListingSource, parseRetryAfter } from "../src/source/http-listing-source.js";

const LISTING = {
  title: "Acme CRM",
  tagline: "Simple CRM for small teams",
  price: "$39/mo",
  description: "Track leads & deals in one place.",
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | undefined;

/** Starts a throwaway HTTP server that plays the part of the source. */
async function startSource(handler: Handler): Promise<string> {
  const started = createServer(handler);
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  const { port } = started.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Stops the server and stops tracking it. New connections are refused from here on. */
async function stopSource(): Promise<void> {
  const running = server;
  server = undefined;
  if (!running) {
    return;
  }
  running.closeAllConnections();
  await new Promise<void>((resolve) => {
    running.close(() => {
      resolve();
    });
  });
}

afterEach(stopSource);

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

const source = (baseUrl: string, timeoutMs = 2000) => new HttpListingSource({ baseUrl, timeoutMs });

describe("HttpListingSource", () => {
  it("returns a normalised listing, ignoring noise and format variants", async () => {
    const baseUrl = await startSource(
      json(200, {
        requestId: "8d1b3f0a",
        viewerCount: 42,
        description: "Track leads &amp; deals in one place.\n",
        price: "USD 39 per month",
        tagline: "  Simple CRM for small teams ",
        title: "Acme&nbsp;CRM",
      }),
    );
    expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({ kind: "ok", listing: LISTING });
  });

  it("requests /listings/:id, encoding the id and tolerating a trailing slash", async () => {
    const paths: (string | undefined)[] = [];
    const baseUrl = await startSource((req, res) => {
      paths.push(req.url);
      json(200, LISTING)(req, res);
    });
    await source(`${baseUrl}/`).fetchListing("acme-crm");
    await source(baseUrl).fetchListing("a/b c?d");
    expect(paths).toEqual(["/listings/acme-crm", "/listings/a%2Fb%20c%3Fd"]);
  });

  it("reports 404 as not found", async () => {
    const baseUrl = await startSource(json(404, { error: "not_found" }));
    expect(await source(baseUrl).fetchListing("nope")).toEqual({ kind: "not_found" });
  });

  it("reports an incomplete listing with the missing fields", async () => {
    const baseUrl = await startSource(json(200, { ...LISTING, price: null, tagline: "" }));
    expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
      kind: "incomplete",
      missing: ["tagline", "price"],
    });
  });

  describe("rate limiting", () => {
    it("reports 429 with the Retry-After wait", async () => {
      const baseUrl = await startSource(json(429, { error: "rate_limited" }, { "retry-after": "3" }));
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "rate_limited",
        retryAfterMs: 3000,
      });
    });

    it("falls back to one second when the header is missing", async () => {
      const baseUrl = await startSource(json(429, { error: "rate_limited" }));
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "rate_limited",
        retryAfterMs: 1000,
      });
    });
  });

  describe("failures", () => {
    it.each([500, 503])("reports a JSON %i as an error", async (status) => {
      const baseUrl = await startSource(json(status, { error: "internal_error" }));
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "error",
        reason: `http_${status}`,
      });
    });

    it("reports an HTML 502 as an error without trying to parse it", async () => {
      const baseUrl = await startSource((_req, res) => {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html><body><h1>502 Bad Gateway</h1></body></html>");
      });
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "error",
        reason: "http_502",
      });
    });

    it("reports other unexpected statuses as errors", async () => {
      const baseUrl = await startSource(json(403, { error: "forbidden" }));
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "error",
        reason: "http_403",
      });
    });

    it.each([
      ["a body that is not JSON", "<html>oops</html>"],
      ["a JSON array", "[]"],
      ["a JSON string", '"hello"'],
      ["an empty body", ""],
    ])("reports a 200 with %s as an invalid body", async (_label, body) => {
      const baseUrl = await startSource((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "error",
        reason: "invalid_body",
      });
    });

    it("gives up on a request that never gets a response", async () => {
      const baseUrl = await startSource(() => {
        // Never answer.
      });
      const startedAt = Date.now();
      const result = await source(baseUrl, 150).fetchListing("acme-crm");
      expect(result).toEqual({ kind: "error", reason: "timeout" });
      expect(Date.now() - startedAt).toBeLessThan(1000);
    });

    it("gives up on a body that stalls after the headers arrived", async () => {
      const baseUrl = await startSource((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"title": "Acme');
        // Never finish.
      });
      expect(await source(baseUrl, 150).fetchListing("acme-crm")).toEqual({
        kind: "error",
        reason: "timeout",
      });
    });

    it("reports a dropped connection as a network error", async () => {
      const baseUrl = await startSource((req) => {
        req.socket.destroy();
      });
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "error",
        reason: "network",
      });
    });

    it("reports an unreachable source as a network error", async () => {
      const baseUrl = await startSource(json(200, LISTING));
      await stopSource();
      expect(await source(baseUrl).fetchListing("acme-crm")).toEqual({
        kind: "error",
        reason: "network",
      });
    });
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");

  it.each([
    ["1", 1000],
    ["60", 60_000],
    ["0", 0],
    ["1.5", 1500],
  ])("reads %j seconds", (header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });

  it("reads an HTTP date as the time left until then", () => {
    expect(parseRetryAfter("Thu, 10 Sep 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Thu, 10 Sep 2026 11:59:00 GMT", now)).toBe(0);
  });

  it.each([[null], [""], ["  "], ["soon"], ["-5"]])("falls back to one second for %j", (header) => {
    expect(parseRetryAfter(header, now)).toBe(1000);
  });
});
