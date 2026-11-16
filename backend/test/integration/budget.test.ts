import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { llmUsage } from "../../src/db/schema.js";
import { LlmBudget, nextUtcMidnight } from "../../src/summarizer/budget.js";
import { openTestDb, resetTables } from "./test-db.js";

const { db, pool } = openTestDb();

const usage = () => db.select().from(llmUsage);
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  await resetTables(db);
});

afterAll(async () => {
  await pool.end();
});

describe("LlmBudget", () => {
  it("allows calls up to the daily cap and refuses the rest", async () => {
    const budget = new LlmBudget(db, 3);
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await budget.tryReserve());
    }
    expect(results).toEqual([true, true, true, false, false, false]);
    expect(await usage()).toEqual([{ day: today(), calls: 3 }]);
  });

  it("never goes over the cap when many calls are reserved at once", async () => {
    const budget = new LlmBudget(db, 7);
    const results = await Promise.all(Array.from({ length: 40 }, () => budget.tryReserve()));
    expect(results.filter(Boolean)).toHaveLength(7);
    expect(await usage()).toEqual([{ day: today(), calls: 7 }]);
  });

  it("allows nothing when the cap is zero", async () => {
    expect(await new LlmBudget(db, 0).tryReserve()).toBe(false);
    expect(await usage()).toEqual([]);
  });

  it("starts a fresh count each UTC day", async () => {
    await db.insert(llmUsage).values({ day: "2026-01-01", calls: 2000 });
    const budget = new LlmBudget(db, 2000);
    expect(await budget.tryReserve()).toBe(true);
    expect(await usage()).toContainEqual({ day: today(), calls: 1 });
  });

  it("shares one count between workers", async () => {
    const first = new LlmBudget(db, 2);
    const second = new LlmBudget(db, 2);
    expect(await first.tryReserve()).toBe(true);
    expect(await second.tryReserve()).toBe(true);
    expect(await first.tryReserve()).toBe(false);
    expect(await second.tryReserve()).toBe(false);
  });
});

describe("nextUtcMidnight", () => {
  it.each([
    ["2026-09-10T00:00:00.000Z", "2026-09-11T00:00:00.000Z"],
    ["2026-09-10T12:34:56.000Z", "2026-09-11T00:00:00.000Z"],
    ["2026-09-10T23:59:59.999Z", "2026-09-11T00:00:00.000Z"],
    ["2026-12-31T18:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["2028-02-28T10:00:00.000Z", "2028-02-29T00:00:00.000Z"],
  ])("after %s is %s", (now, expected) => {
    expect(nextUtcMidnight(new Date(now)).toISOString()).toBe(expected);
  });
});
