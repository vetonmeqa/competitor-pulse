import { describe, expect, it } from "vitest";
import { formatDuration, formatRelative } from "./format";

describe("formatRelative", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  const before = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

  it.each([
    [0, "just now"],
    [59, "just now"],
    [60, "1 minute ago"],
    [5 * 60, "5 minutes ago"],
    [59 * 60 + 59, "59 minutes ago"],
    [60 * 60, "1 hour ago"],
    [23 * 60 * 60, "23 hours ago"],
    [24 * 60 * 60, "yesterday"],
    [3 * 24 * 60 * 60, "3 days ago"],
  ])("describes %i seconds ago as %j", (seconds, expected) => {
    expect(formatRelative(before(seconds), now)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it.each([
    [45, "45 s"],
    [60, "1 min"],
    [900, "15 min"],
    [3600, "1 h"],
    [7800, "2 h 10 min"],
  ])("writes %i seconds as %j", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
