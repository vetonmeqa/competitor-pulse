import { describe, expect, it } from "vitest";
import { contentHash, diffFields, normalizeText, parseListing } from "../src/domain/listing.js";

const RAW = {
  title: "Acme CRM",
  tagline: "Simple CRM for small teams",
  price: "$39/mo",
  description: "Track leads & deals in one place.",
};

const LISTING = { ...RAW };

function parsed(raw: unknown) {
  const result = parseListing(raw);
  if (result.kind !== "ok") {
    throw new Error(`expected a listing, got ${result.kind}`);
  }
  return result.listing;
}

describe("normalizeText", () => {
  it.each([
    ["  Track leads & deals in one place. ", "padding"],
    ["Track  leads &  deals in   one place.", "doubled spaces"],
    ["Track leads &amp; deals in one place.", "an encoded ampersand"],
    ["Track&nbsp;leads & deals in one place.", "a non-breaking space"],
    ["Track leads & deals in one place.\n", "a trailing newline"],
  ])("ignores %j (%s)", (input) => {
    expect(normalizeText(input)).toBe("Track leads & deals in one place.");
  });

  it("keeps real differences in wording, case and punctuation", () => {
    expect(normalizeText("Track leads and deals.")).not.toBe(normalizeText("Track leads & deals."));
    expect(normalizeText("Acme CRM")).not.toBe(normalizeText("ACME CRM"));
  });
});

describe("parseListing", () => {
  it("returns the four tracked fields, normalised", () => {
    expect(parsed(RAW)).toEqual(LISTING);
  });

  it("ignores noise fields and key order", () => {
    const noisy = {
      viewerCount: 117,
      description: RAW.description,
      cache: { hit: true, ageSeconds: 12 },
      price: RAW.price,
      requestId: "0b9f4c0e-6f0e-4a55-9d0e-1c6f6f7d2b11",
      title: RAW.title,
      promoBanner: "Spring sale: 20% off annual plans",
      renderedAt: "2026-09-10T12:00:00.000Z",
      tagline: RAW.tagline,
      id: "acme-crm",
    };
    expect(parsed(noisy)).toEqual(LISTING);
  });

  it("gives the same listing for every format variant of the same content", () => {
    const variant = {
      title: " Acme&nbsp;CRM ",
      tagline: "Simple  CRM for small   teams\n",
      price: "USD 39 per month",
      description: "Track leads &amp; deals in one place.",
    };
    expect(parsed(variant)).toEqual(LISTING);
    expect(contentHash(parsed(variant))).toBe(contentHash(parsed(RAW)));
  });

  it.each([
    ["missing", (): unknown => ({ title: RAW.title, tagline: RAW.tagline, price: RAW.price })],
    ["null", (): unknown => ({ ...RAW, description: null })],
    ["empty", (): unknown => ({ ...RAW, description: "" })],
    ["blank", (): unknown => ({ ...RAW, description: " &nbsp;\n" })],
    ["not a string", (): unknown => ({ ...RAW, description: 42 })],
  ])("reports a %s field as incomplete", (_label, build) => {
    expect(parseListing(build())).toEqual({ kind: "incomplete", missing: ["description"] });
  });

  it("names every missing field", () => {
    expect(parseListing({ title: "Acme CRM" })).toEqual({
      kind: "incomplete",
      missing: ["tagline", "price", "description"],
    });
  });

  it.each([[null], ["<html>502</html>"], [42], [[RAW]]])("rejects %j as invalid", (raw) => {
    expect(parseListing(raw)).toEqual({ kind: "invalid" });
  });
});

describe("diffFields and contentHash", () => {
  it("names the fields that differ", () => {
    const after = { ...LISTING, price: "$29/mo", tagline: "The CRM small teams love" };
    expect(diffFields(LISTING, after)).toEqual(["tagline", "price"]);
    expect(diffFields(LISTING, { ...LISTING })).toEqual([]);
  });

  it("changes the hash when any field changes", () => {
    const hashes = [
      LISTING,
      { ...LISTING, title: "Acme" },
      { ...LISTING, tagline: "x" },
      { ...LISTING, price: "$29/mo" },
      { ...LISTING, description: "x" },
    ].map(contentHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("does not confuse a value moving between fields", () => {
    const a = { title: "a", tagline: "b", price: "c", description: "d" };
    const b = { title: "a", tagline: "", price: "bc", description: "d" };
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});
