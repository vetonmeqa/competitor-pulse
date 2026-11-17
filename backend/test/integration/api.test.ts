import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import type { CompetitorDto, SnapshotDto, StatusDto } from "../../src/api/dto.js";
import { llmUsage, workerStatus } from "../../src/db/schema.js";
import type { Observation } from "../../src/domain/evaluate.js";
import type { Listing } from "../../src/domain/listing.js";
import { PollStore } from "../../src/poller/poll-store.js";
import { type WorkerReport, writeWorkerReport } from "../../src/worker-status.js";
import { A, addCompetitor, B, C, minutesAgo, openTestDb, resetTables } from "./test-db.js";

const { db, pool } = openTestDb();
const store = new PollStore(db);
const app = buildApp({
  db,
  log: pino({ level: "silent" }),
  config: { POLL_INTERVAL_SECONDS: 900, LLM_DAILY_CAP: 2000 },
});

const ok = (listing: Listing): Observation => ({ kind: "ok", listing });
const NOT_FOUND: Observation = { kind: "not_found" };
const ID = "acme-crm";

const get = (url: string) => app.inject({ method: "GET", url });
const post = (payload?: object) =>
  app.inject({ method: "POST", url: "/api/competitors", ...(payload ? { payload } : {}) });
const remove = (id: string) => app.inject({ method: "DELETE", url: `/api/competitors/${id}` });

/** A page of the list: the array in the body, and the counts from the response headers. */
interface CompetitorPage {
  items: CompetitorDto[];
  page: number;
  pageSize: number;
  total: number;
  totalTracked: number;
}

async function competitorPage(query = ""): Promise<CompetitorPage> {
  const response = await get(`/api/competitors${query}`);
  const header = (name: string) => Number(response.headers[name]);
  return {
    items: response.json(),
    page: header("x-page"),
    pageSize: header("x-page-size"),
    total: header("x-total-count"),
    totalTracked: header("x-total-tracked"),
  };
}

/** The first page of the list, which holds everything in a test with a few competitors. */
async function listCompetitors(): Promise<CompetitorDto[]> {
  return (await competitorPage()).items;
}

async function listSnapshots(id = ID, query = ""): Promise<SnapshotDto[]> {
  return (await get(`/api/competitors/${id}/snapshots${query}`)).json();
}

async function getStatus(): Promise<StatusDto> {
  return (await get("/api/status")).json();
}

/** Records polls one minute apart, the last one a minute ago. */
async function record(observations: Observation[], id = ID): Promise<void> {
  for (const [index, observation] of observations.entries()) {
    await store.recordPoll(id, minutesAgo(observations.length - index), observation);
  }
}

beforeEach(async () => {
  await resetTables(db);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("GET /api/health", () => {
  it("answers when the database is reachable", async () => {
    const response = await get("/api/health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe("POST /api/competitors", () => {
  it("starts tracking a competitor and answers 201", async () => {
    const response = await post({ id: ID });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: ID,
      availability: "unknown",
      title: null,
      lastPolledAt: null,
      changedInLast24h: false,
    });
    expect(await listCompetitors()).toMatchObject([{ id: ID }]);
  });

  it("accepts an id the source may not know", async () => {
    expect((await post({ id: "nobody-has-heard-of-this" })).statusCode).toBe(201);
  });

  it("trims surrounding whitespace", async () => {
    expect((await post({ id: "  acme-crm " })).json()).toMatchObject({ id: ID });
  });

  it("puts the new competitor at the head of the poll queue", async () => {
    await addCompetitor(db, "overdue-for-an-hour", minutesAgo(60));
    await post({ id: ID });
    expect(await store.claimNextDue(900)).toBe(ID);
  });

  it("answers 409 for a competitor that is already tracked", async () => {
    await post({ id: ID });
    const response = await post({ id: ID });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "already_tracked", message: '"acme-crm" is already tracked.' },
    });
    expect(await listCompetitors()).toHaveLength(1);
  });

  it.each([
    ["an empty id", { id: "" }],
    ["a blank id", { id: "   " }],
    ["an id with a space", { id: "acme crm" }],
    ["an id with a slash", { id: "acme/crm" }],
    ["an id that is too long", { id: "a".repeat(101) }],
    ["an id that is not a string", { id: 42 }],
    ["a missing id", {}],
    ["no body", undefined],
  ])("answers 400 for %s", async (_label, payload) => {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_id" } });
    expect(await listCompetitors()).toEqual([]);
  });

  it("answers 400 for a body that is not valid JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/competitors",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "bad_request" } });
  });
});

describe("GET /api/competitors", () => {
  it("returns an empty first page when nothing is tracked", async () => {
    expect(await competitorPage()).toEqual({
      items: [],
      page: 1,
      pageSize: 25,
      total: 0,
      totalTracked: 0,
    });
  });

  it("lists competitors by id, with their latest state", async () => {
    await addCompetitor(db, "orbit-hr");
    await addCompetitor(db, ID);
    await record([ok(A)]);

    const list = await listCompetitors();
    expect(list.map((competitor) => competitor.id)).toEqual([ID, "orbit-hr"]);
    expect(list[0]).toMatchObject({
      availability: "listed",
      title: "Acme CRM",
      lastPollStatus: "ok",
      lastChangedAt: null,
      changedInLast24h: false,
    });
    expect(list[1]).toMatchObject({ availability: "unknown", title: null, lastPolledAt: null });
  });

  it("flags only the competitors that changed in the last 24 hours", async () => {
    const hoursAgo = (hours: number) => minutesAgo(hours * 60);
    for (const [id, changedAt] of [
      ["changed-an-hour-ago", hoursAgo(1)],
      ["changed-23-hours-ago", hoursAgo(23)],
      ["changed-25-hours-ago", hoursAgo(25)],
    ] as const) {
      await addCompetitor(db, id);
      await store.recordPoll(id, hoursAgo(30), ok(A));
      await store.recordPoll(id, changedAt, ok(B));
      // Polled since, with nothing new: that does not make it "changed" again.
      await store.recordPoll(id, minutesAgo(1), ok(B));
    }
    await addCompetitor(db, "never-changed");
    await store.recordPoll("never-changed", minutesAgo(1), ok(A));

    const flags = Object.fromEntries(
      (await listCompetitors()).map((competitor) => [competitor.id, competitor.changedInLast24h]),
    );
    expect(flags).toEqual({
      "changed-an-hour-ago": true,
      "changed-23-hours-ago": true,
      "changed-25-hours-ago": false,
      "never-changed": false,
    });
  });

  it("keeps showing the last known title while a competitor is delisted", async () => {
    await addCompetitor(db, ID);
    await record([ok(A), NOT_FOUND]);
    expect(await listCompetitors()).toMatchObject([
      { availability: "delisted", title: "Acme CRM", changedInLast24h: true },
    ]);
  });
});

describe("GET /api/competitors, paging", () => {
  it("answers with the plain array of the contract, and the counts in headers", async () => {
    await addCompetitor(db, ID);
    const response = await get("/api/competitors");

    expect(response.json()).toMatchObject([{ id: ID }]);
    expect(response.headers).toMatchObject({
      "x-page": "1",
      "x-page-size": "25",
      "x-total-count": "1",
      "x-total-tracked": "1",
    });
  });

  /** c01 to c07, added out of order. */
  async function addSeven(): Promise<void> {
    for (const number of [5, 2, 7, 1, 4, 6, 3]) {
      await addCompetitor(db, `c0${number}`);
    }
  }
  const ids = (page: CompetitorPage) => page.items.map((competitor) => competitor.id);

  it("returns one page at a time, by id, with the total", async () => {
    await addSeven();

    const first = await competitorPage("?pageSize=3");
    expect(ids(first)).toEqual(["c01", "c02", "c03"]);
    expect(first).toMatchObject({ page: 1, pageSize: 3, total: 7, totalTracked: 7 });

    expect(ids(await competitorPage("?pageSize=3&page=2"))).toEqual(["c04", "c05", "c06"]);

    const last = await competitorPage("?pageSize=3&page=3");
    expect(ids(last)).toEqual(["c07"]);
    expect(last).toMatchObject({ page: 3, total: 7 });
  });

  it("returns 25 competitors per page unless asked otherwise", async () => {
    for (let number = 1; number <= 30; number++) {
      await addCompetitor(db, `c${String(number).padStart(2, "0")}`);
    }
    const page = await competitorPage();
    expect(page.items).toHaveLength(25);
    expect(page).toMatchObject({ page: 1, pageSize: 25, total: 30 });
  });

  it("returns the last page when the page asked for is past the end", async () => {
    await addSeven();
    const page = await competitorPage("?pageSize=3&page=9");
    expect(ids(page)).toEqual(["c07"]);
    expect(page.page).toBe(3);
  });

  it("steps back a page when the only competitor on the last page is removed", async () => {
    await addSeven();
    await remove("c07");
    const page = await competitorPage("?pageSize=3&page=3");
    expect(ids(page)).toEqual(["c04", "c05", "c06"]);
    expect(page).toMatchObject({ page: 2, total: 6 });
  });

  it.each(["?page=0", "?page=-1", "?page=abc", "?page=1.5", "?pageSize=0", "?pageSize=101"])(
    "rejects %s",
    async (query) => {
      const response = await get(`/api/competitors${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_query" } });
    },
  );
});

describe("GET /api/competitors, search", () => {
  beforeEach(async () => {
    await addCompetitor(db, ID);
    await record([ok(A)]); // titled "Acme CRM"
    await addCompetitor(db, "orbit-hr");
    await record([ok({ ...A, title: "Orbit HR" })], "orbit-hr");
    await addCompetitor(db, "acme-payroll"); // never polled, so it has no title
    await addCompetitor(db, "north_analytics");
  });
  const search = async (text: string, rest = "") =>
    competitorPage(`?q=${encodeURIComponent(text)}${rest}`);
  const ids = (page: CompetitorPage) => page.items.map((competitor) => competitor.id);

  it("finds competitors whose id contains the text", async () => {
    const page = await search("acme");
    expect(ids(page)).toEqual(["acme-crm", "acme-payroll"]);
    expect(page).toMatchObject({ total: 2, totalTracked: 4 });
  });

  it("finds competitors by their current title", async () => {
    expect(ids(await search("orbit h"))).toEqual(["orbit-hr"]);
    expect(ids(await search("CRM"))).toEqual(["acme-crm"]);
  });

  it("ignores letter case and spaces around the text", async () => {
    expect(ids(await search("  ACME-p "))).toEqual(["acme-payroll"]);
  });

  it("searches every competitor, not only the page being shown", async () => {
    const page = await search("analytics", "&pageSize=1");
    expect(ids(page)).toEqual(["north_analytics"]);
    expect(page).toMatchObject({ page: 1, total: 1 });
  });

  it("pages through the matches and counts only them", async () => {
    const page = await search("acme", "&pageSize=1&page=2");
    expect(ids(page)).toEqual(["acme-payroll"]);
    expect(page).toMatchObject({ page: 2, total: 2, totalTracked: 4 });
  });

  it("returns an empty page and the tracked count when nothing matches", async () => {
    expect(await search("zzz")).toEqual({
      items: [],
      page: 1,
      pageSize: 25,
      total: 0,
      totalTracked: 4,
    });
  });

  it("treats %, _ and \\ as plain characters, not as wildcards", async () => {
    expect(ids(await search("%"))).toEqual([]);
    expect(ids(await search("\\"))).toEqual([]);
    // As a wildcard, "_" would match any single character and so every competitor.
    expect(ids(await search("_"))).toEqual(["north_analytics"]);
    expect(ids(await search("north_a"))).toEqual(["north_analytics"]);
    expect(ids(await search("north-a"))).toEqual([]);
  });

  it("returns everything for an empty search", async () => {
    expect((await search("   ")).total).toBe(4);
  });

  it("rejects a search text longer than 100 characters", async () => {
    const response = await get(`/api/competitors?q=${"a".repeat(101)}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_query" } });
  });
});

describe("GET /api/competitors/:id", () => {
  it("returns one competitor with its latest state", async () => {
    await addCompetitor(db, ID);
    await record([ok(A), ok(B)]);

    const response = await get(`/api/competitors/${ID}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: ID,
      availability: "listed",
      title: "Acme CRM",
      lastPollStatus: "ok",
      changedInLast24h: true,
    });
  });

  it("answers 404 for a competitor that is not tracked", async () => {
    const response = await get("/api/competitors/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_tracked" } });
  });
});

describe("DELETE /api/competitors/:id", () => {
  it("stops tracking, deletes the history and answers 204 with no body", async () => {
    await addCompetitor(db, ID);
    await record([ok(A), ok(B)]);

    const response = await remove(ID);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(await listCompetitors()).toEqual([]);
    expect((await get(`/api/competitors/${ID}/snapshots`)).statusCode).toBe(404);
  });

  it("starts from a clean history when the competitor is added again", async () => {
    await addCompetitor(db, ID);
    await record([ok(A), ok(B)]);
    await remove(ID);
    await post({ id: ID });
    expect(await listSnapshots()).toEqual([]);
  });

  it("answers 404 for a competitor that is not tracked", async () => {
    const response = await remove("nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_tracked" } });
  });
});

describe("GET /api/competitors/:id/snapshots", () => {
  beforeEach(async () => {
    await addCompetitor(db, ID);
  });

  it("answers 404 for a competitor that is not tracked", async () => {
    expect((await get("/api/competitors/nope/snapshots")).statusCode).toBe(404);
  });

  it("returns an empty list before the first poll", async () => {
    expect(await listSnapshots()).toEqual([]);
  });

  it("returns snapshots newest first, with the fields of the contract", async () => {
    await record([ok(A), ok(C)]);

    const [newest, oldest] = await listSnapshots();
    expect(newest).toMatchObject({
      title: "Acme CRM",
      tagline: "The CRM small teams love",
      price: "$29/mo",
      description: "Track leads & deals in one place.",
      changed: true,
      summary: null,
    });
    expect(oldest).toMatchObject({ price: "$39/mo", changed: false, summary: null });
    expect(newest?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(String(newest?.fetchedAt))).toBeGreaterThan(
      Date.parse(String(oldest?.fetchedAt)),
    );
  });

  it("shows what changed, field by field, even while the summary is pending", async () => {
    await record([ok(A), ok(C)]);

    const [change] = await listSnapshots();
    expect(change).toMatchObject({
      status: "ok",
      changeKind: "content",
      summaryStatus: "pending",
      summarySource: null,
      summaryReason: { code: "generating", message: "The summary is being generated." },
      changes: [
        { field: "tagline", before: "Simple CRM for small teams", after: "The CRM small teams love" },
        { field: "price", before: "$39/mo", after: "$29/mo" },
      ],
    });
  });

  it("explains every snapshot that has no summary", async () => {
    await record([
      ok(A),
      ok(A),
      { kind: "error", reason: "timeout" },
      { kind: "incomplete", missing: ["price"] },
    ]);

    const snapshots = await listSnapshots();
    expect(snapshots.map((snapshot) => snapshot.summaryReason?.code)).toEqual([
      "incomplete_listing",
      "poll_failed",
      "no_change",
      "first_snapshot",
    ]);
    expect(snapshots.every((snapshot) => snapshot.summary === null)).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.changes.length === 0)).toBe(true);
  });

  it("returns null listing fields and the reason for a failed poll", async () => {
    await record([ok(A), { kind: "error", reason: "http_503" }]);

    const [failed] = await listSnapshots();
    expect(failed).toMatchObject({
      status: "error",
      statusDetail: "http_503",
      title: null,
      tagline: null,
      price: null,
      description: null,
      changed: false,
      summaryReason: {
        code: "poll_failed",
        message: "The poll failed (the source answered with HTTP 503), so there is nothing to compare.",
      },
    });
  });

  it("returns template summaries with no reason attached", async () => {
    await record([ok(A), ok(B), ok(A), NOT_FOUND]);

    const [delisted, reverted] = await listSnapshots();
    expect(reverted).toMatchObject({
      changeKind: "revert",
      summaryStatus: "done",
      summarySource: "template",
      summaryReason: null,
      changes: [{ field: "tagline", before: B.tagline, after: A.tagline }],
    });
    expect(reverted?.summary).toContain("Reverted to the previous version");
    expect(delisted).toMatchObject({
      status: "not_found",
      changed: true,
      changeKind: "delisted",
      title: null,
      summaryReason: null,
      changes: [],
    });
    expect(delisted?.summary).toContain('last seen as "Acme CRM" at $39/mo');
  });

  it("explains a competitor the source has never listed", async () => {
    await record([NOT_FOUND]);
    expect(await listSnapshots()).toMatchObject([
      {
        status: "not_found",
        changed: false,
        summaryReason: { code: "not_found", message: "The source does not list this competitor." },
      },
    ]);
  });

  it("limits the number of snapshots, keeping the newest", async () => {
    await record([ok(A), ok(B), ok(C)]);
    const limited = await listSnapshots(ID, "?limit=2");
    expect(limited.map((snapshot) => snapshot.price)).toEqual(["$29/mo", "$39/mo"]);
    expect(limited.map((snapshot) => snapshot.tagline)).toEqual([C.tagline, B.tagline]);
  });

  it("can return only the changes", async () => {
    await record([ok(A), ok(A), ok(B), ok(B), { kind: "error", reason: "timeout" }, ok(C)]);
    const changes = await listSnapshots(ID, "?changedOnly=true");
    expect(changes.map((snapshot) => snapshot.price)).toEqual(["$29/mo", "$39/mo"]);
    expect(changes.every((snapshot) => snapshot.changed)).toBe(true);
  });

  describe("paging with ?before", () => {
    const prices = (list: SnapshotDto[]) => list.map((snapshot) => snapshot.price);
    const priced = (number: number): Observation => ok({ ...A, price: `€${String(number)}` });
    /** Seven polls with the prices €1 (oldest) to €7 (newest), each one a change. */
    async function recordSeven(): Promise<void> {
      await record([1, 2, 3, 4, 5, 6, 7].map(priced));
    }
    /** Reads the whole history a page at a time, the way the app does. */
    async function readAll(limit: number, rest = ""): Promise<SnapshotDto[][]> {
      const pages: SnapshotDto[][] = [];
      let before = "";
      for (;;) {
        const page = await listSnapshots(ID, `?limit=${String(limit)}${before}${rest}`);
        pages.push(page);
        const last = page.at(-1);
        if (page.length < limit || last === undefined) {
          return pages;
        }
        before = `&before=${String(last.id)}`;
      }
    }

    it("returns the snapshots older than the given one, newest first", async () => {
      await recordSeven();
      const first = await listSnapshots(ID, "?limit=3");
      expect(prices(first)).toEqual(["€7", "€6", "€5"]);

      const older = await listSnapshots(ID, `?limit=3&before=${String(first.at(-1)?.id)}`);
      expect(prices(older)).toEqual(["€4", "€3", "€2"]);
    });

    it("walks the whole history with no snapshot missing or repeated", async () => {
      await recordSeven();
      const pages = await readAll(3);
      expect(pages.map(prices)).toEqual([["€7", "€6", "€5"], ["€4", "€3", "€2"], ["€1"]]);
    });

    it("is not shifted by polls that arrive while someone is paging", async () => {
      await recordSeven();
      const first = await listSnapshots(ID, "?limit=3");
      await store.recordPoll(ID, new Date(), priced(8));
      await store.recordPoll(ID, new Date(), priced(9));

      const older = await listSnapshots(ID, `?limit=3&before=${String(first.at(-1)?.id)}`);
      expect(prices(older)).toEqual(["€4", "€3", "€2"]);
    });

    it("keeps the order of snapshots that have the same time", async () => {
      const sameTime = minutesAgo(5);
      for (const number of [1, 2, 3, 4]) {
        await store.recordPoll(ID, sameTime, priced(number));
      }
      expect((await readAll(1)).map(prices)).toEqual([["€4"], ["€3"], ["€2"], ["€1"], []]);
    });

    it("pages through the changes only, when asked", async () => {
      await record([ok(A), ok(A), ok(B), ok(B), ok(C), ok(C), ok(A)]);
      const pages = await readAll(1, "&changedOnly=true");
      expect(pages.map((page) => page.map((snapshot) => snapshot.tagline))).toEqual([
        [A.tagline],
        [C.tagline],
        [B.tagline],
        [],
      ]);
      expect(pages.flat().every((snapshot) => snapshot.changed)).toBe(true);
    });

    it("returns nothing after the oldest snapshot", async () => {
      await recordSeven();
      const oldest = (await listSnapshots()).at(-1);
      expect(await listSnapshots(ID, `?before=${String(oldest?.id)}`)).toEqual([]);
    });

    it("returns nothing for a snapshot that does not exist or belongs to another competitor", async () => {
      await recordSeven();
      await addCompetitor(db, "orbit-hr");
      await record([ok(B)], "orbit-hr");
      const [other] = await listSnapshots("orbit-hr");

      expect(await listSnapshots(ID, "?before=999999")).toEqual([]);
      expect(await listSnapshots(ID, `?before=${String(other?.id)}`)).toEqual([]);
    });

    it.each(["?before=0", "?before=-3", "?before=abc", "?before=1.5"])(
      "answers 400 for %s",
      async (query) => {
        const response = await get(`/api/competitors/${ID}/snapshots${query}`);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "invalid_query" } });
      },
    );
  });

  it.each(["?limit=0", "?limit=abc", "?limit=5000", "?limit=1.5", "?changedOnly=maybe"])(
    "answers 400 for %s",
    async (query) => {
      const response = await get(`/api/competitors/${ID}/snapshots${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_query" } });
    },
  );
});

describe("GET /api/status", () => {
  const report: WorkerReport = {
    startedAt: "2026-09-10T12:00:00.000Z",
    poller: {
      inFlight: 2,
      polls: { ok: 40, not_found: 3, incomplete: 1, error: 2, rate_limited: 4 },
      rateLimiter: {
        maxRatePerSecond: 5,
        currentRatePerSecond: 3.5,
        pausedForMs: 0,
        rateLimitedCount: 4,
      },
    },
    summarizer: {
      provider: "openai-compatible (mock-llm)",
      breaker: { state: "closed", consecutiveFailures: 0, retryInMs: 0 },
      summaries: { done: 12, retried: 2, failed: 1, deferredForCap: 0 },
    },
  };

  it("reports an idle system before anything has run", async () => {
    const response = await get("/api/status");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      polling: { competitors: 0, intervalSeconds: 900, overdue: 0, oldestOverdueSeconds: null },
      summaries: { pending: 0, llmCallsToday: 0, llmDailyCap: 2000 },
      worker: null,
    });
  });

  it("reports how far behind the poll queue is", async () => {
    await addCompetitor(db, "on-time", new Date(Date.now() + 60_000));
    await addCompetitor(db, "five-minutes-late", minutesAgo(5));
    await addCompetitor(db, "two-minutes-late", minutesAgo(2));
    // Just added: at the head of the queue, but not "56 years late".
    await addCompetitor(db, "brand-new");

    const { polling } = await getStatus();
    expect(polling).toMatchObject({ competitors: 4, overdue: 3 });
    expect(polling.oldestOverdueSeconds).toBeGreaterThanOrEqual(299);
    expect(polling.oldestOverdueSeconds).toBeLessThan(310);
  });

  it("reports pending summaries and today's LLM calls", async () => {
    await addCompetitor(db, ID);
    await record([ok(A), ok(B), ok(C)]);
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(llmUsage).values([
      { day: today, calls: 17 },
      { day: "2026-01-01", calls: 2000 },
    ]);

    expect(await getStatus()).toMatchObject({
      summaries: { pending: 2, llmCallsToday: 17, llmDailyCap: 2000 },
    });
  });

  it("shows the worker's own numbers while it keeps reporting", async () => {
    await writeWorkerReport(db, report);
    const { worker } = await getStatus();
    expect(worker).toMatchObject({ running: true, ...report });
  });

  it("shows the worker as not running once its reports stop", async () => {
    await writeWorkerReport(db, report);
    await db.update(workerStatus).set({ updatedAt: minutesAgo(2) }).where(eq(workerStatus.id, 1));

    const { worker } = await getStatus();
    expect(worker?.running).toBe(false);
    expect(worker?.poller.rateLimiter.currentRatePerSecond).toBe(3.5);
  });

  it("keeps a single status row however often the worker reports", async () => {
    await writeWorkerReport(db, report);
    await writeWorkerReport(db, { ...report, startedAt: "2026-09-11T08:00:00.000Z" });
    expect(await db.$count(workerStatus)).toBe(1);
    expect((await getStatus()).worker?.startedAt).toBe("2026-09-11T08:00:00.000Z");
  });
});

describe("unknown routes", () => {
  it("answer 404 as JSON", async () => {
    const response = await get("/api/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message: "No such route." } });
  });
});
