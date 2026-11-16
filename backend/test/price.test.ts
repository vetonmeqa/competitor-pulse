import { describe, expect, it } from "vitest";
import { normalizePrice } from "../src/domain/price.js";

describe("normalizePrice", () => {
  it.each([
    // The four ways the source writes one monthly price.
    ["$29/mo", "$29/mo"],
    ["$29 / month", "$29/mo"],
    ["USD 29 per month", "$29/mo"],
    ["$29.00/mo", "$29/mo"],
    // Yearly.
    ["€96/yr", "€96/yr"],
    ["€96 / year", "€96/yr"],
    ["EUR 96 per year", "€96/yr"],
    ["€96.00/yr", "€96/yr"],
    // Per seat.
    ["€8/seat/mo", "€8/seat/mo"],
    ["€8 / seat / month", "€8/seat/mo"],
    ["EUR 8 per seat per month", "€8/seat/mo"],
    ["€8.00/seat/mo", "€8/seat/mo"],
    ["£5/mo", "£5/mo"],
    ["GBP 5 per month", "£5/mo"],
  ])("writes %j as %j", (input, expected) => {
    expect(normalizePrice(input)).toBe(expected);
  });

  it("treats every way of saying free as the same price", () => {
    for (const input of ["Free", "free", "Free forever", "$0/mo", "€0/mo", "USD 0 per month"]) {
      expect(normalizePrice(input)).toBe("Free");
    }
  });

  it("keeps cents when the amount has them", () => {
    expect(normalizePrice("$12.50/mo")).toBe("$12.50/mo");
    expect(normalizePrice("$12.5/mo")).toBe("$12.50/mo");
    expect(normalizePrice("USD 12.50 per month")).toBe("$12.50/mo");
  });

  it("handles a currency without a known symbol", () => {
    expect(normalizePrice("CHF 5/mo")).toBe("CHF 5/mo");
    expect(normalizePrice("CHF 5 per month")).toBe("CHF 5/mo");
    expect(normalizePrice("chf 5.00/mo")).toBe("CHF 5/mo");
  });

  it("handles thousands separators and a price with no period", () => {
    expect(normalizePrice("$1,299/yr")).toBe("$1299/yr");
    expect(normalizePrice("$499")).toBe("$499");
  });

  it("keeps a billing unit it does not know", () => {
    expect(normalizePrice("$3/gb")).toBe("$3/gb");
    expect(normalizePrice("USD 3 per gb")).toBe("$3/gb");
  });

  it("tells different prices apart", () => {
    const prices = ["$29/mo", "$39/mo", "€29/mo", "$29/yr", "$29/seat/mo", "Free"].map(
      normalizePrice,
    );
    expect(new Set(prices).size).toBe(prices.length);
  });

  it("returns text it cannot parse unchanged, so it is still compared", () => {
    expect(normalizePrice("Contact sales")).toBe("Contact sales");
    expect(normalizePrice("Free trial, then $29/mo")).toBe("Free trial, then $29/mo");
    expect(normalizePrice("$29 billed annually")).toBe("$29 billed annually");
  });
});
