import { describe, expect, it } from "vitest";
import { pageCountFor, pageSlots, parsePage } from "./pagination";

describe("pageSlots", () => {
  it("shows every page when there are seven or fewer", () => {
    expect(pageSlots(1, 1)).toEqual([1]);
    expect(pageSlots(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageSlots(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("leaves out the far pages near the start", () => {
    expect(pageSlots(1, 40)).toEqual([1, 2, 3, 4, 5, "gap-after", 40]);
    expect(pageSlots(4, 40)).toEqual([1, 2, 3, 4, 5, "gap-after", 40]);
  });

  it("shows the current page with its neighbours in the middle", () => {
    expect(pageSlots(5, 40)).toEqual([1, "gap-before", 4, 5, 6, "gap-after", 40]);
    expect(pageSlots(20, 40)).toEqual([1, "gap-before", 19, 20, 21, "gap-after", 40]);
    expect(pageSlots(36, 40)).toEqual([1, "gap-before", 35, 36, 37, "gap-after", 40]);
  });

  it("leaves out the early pages near the end", () => {
    expect(pageSlots(37, 40)).toEqual([1, "gap-before", 36, 37, 38, 39, 40]);
    expect(pageSlots(40, 40)).toEqual([1, "gap-before", 36, 37, 38, 39, 40]);
  });

  it("always has seven places and the current page once there are more than seven pages", () => {
    for (const pageCount of [8, 9, 40, 240]) {
      for (let current = 1; current <= pageCount; current++) {
        const slots = pageSlots(current, pageCount);
        expect(slots).toHaveLength(7);
        expect(slots).toContain(current);
        expect(slots[0]).toBe(1);
        expect(slots.at(-1)).toBe(pageCount);
      }
    }
  });

  it("never hides a single page behind a gap", () => {
    // A gap that stands for one page would be better shown as that page.
    for (let current = 1; current <= 8; current++) {
      const numbers = pageSlots(current, 8).filter((slot) => typeof slot === "number");
      expect(numbers.length).toBeGreaterThanOrEqual(5);
    }
    expect(pageSlots(4, 8)).toEqual([1, 2, 3, 4, 5, "gap-after", 8]);
    expect(pageSlots(5, 8)).toEqual([1, "gap-before", 4, 5, 6, 7, 8]);
  });
});

describe("parsePage", () => {
  it("reads a whole number from 1 up", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("12")).toBe(12);
  });

  it.each([null, "", "0", "-2", "1.5", "abc", "2x", " 3", "99999999999"])(
    "falls back to the first page for %j",
    (raw) => {
      expect(parsePage(raw)).toBe(1);
    },
  );
});

describe("pageCountFor", () => {
  it("rounds up, and never goes below one page", () => {
    expect(pageCountFor(0, 25)).toBe(1);
    expect(pageCountFor(25, 25)).toBe(1);
    expect(pageCountFor(26, 25)).toBe(2);
    expect(pageCountFor(6000, 25)).toBe(240);
  });
});
