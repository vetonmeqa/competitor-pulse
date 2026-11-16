import { describe, expect, it } from "vitest";
import {
  type CompetitorState,
  evaluatePoll,
  INITIAL_STATE,
  type Observation,
  type PollDecision,
} from "../src/domain/evaluate.js";
import type { Listing } from "../src/domain/listing.js";

const A: Listing = {
  title: "Acme CRM",
  tagline: "Simple CRM for small teams",
  price: "$39/mo",
  description: "Track leads & deals in one place.",
};
const B: Listing = { ...A, tagline: "The CRM small teams love" };
const C: Listing = { ...B, price: "$29/mo" };

const ok = (listing: Listing): Observation => ({ kind: "ok", listing });
const NOT_FOUND: Observation = { kind: "not_found" };

const listed = (current: Listing, previous: Listing | null = null): CompetitorState => ({
  availability: "listed",
  current,
  previous,
});

/** Feeds a series of polls through the decision function, carrying the state forward. */
function run(observations: Observation[], start: CompetitorState = INITIAL_STATE): PollDecision[] {
  const decisions: PollDecision[] = [];
  let state = start;
  for (const observation of observations) {
    const decision = evaluatePoll(state, observation);
    decisions.push(decision);
    state = decision.next;
  }
  return decisions;
}

describe("evaluatePoll", () => {
  it("treats the first good listing as a baseline, not a change", () => {
    const decision = evaluatePoll(INITIAL_STATE, ok(A));
    expect(decision).toMatchObject({
      status: "ok",
      changed: false,
      changeKind: "initial",
      summary: { kind: "none" },
      next: { availability: "listed", current: A, previous: null },
    });
  });

  it("reports no change when the content is the same", () => {
    const state = listed(A);
    const decision = evaluatePoll(state, ok({ ...A }));
    expect(decision).toMatchObject({ status: "ok", changed: false, changeKind: null });
    expect(decision.summary).toEqual({ kind: "none" });
    expect(decision.next).toBe(state);
  });

  it("reports a content change and asks for an LLM summary", () => {
    const decision = evaluatePoll(listed(A), ok(C));
    expect(decision).toMatchObject({
      status: "ok",
      changed: true,
      changeKind: "content",
      changedFields: ["tagline", "price"],
      summary: { kind: "llm" },
      next: { availability: "listed", current: C, previous: A },
    });
  });

  it("recognises a revert and summarises it without the LLM", () => {
    const decision = evaluatePoll(listed(B, A), ok(A));
    expect(decision).toMatchObject({
      changed: true,
      changeKind: "revert",
      changedFields: ["tagline"],
      next: { current: A, previous: B },
    });
    expect(decision.summary).toEqual({
      kind: "template",
      text:
        'Reverted to the previous version: tagline is back to "Simple CRM for small teams" ' +
        '(was "The CRM small teams love"). This may be an A/B test or a rollback.',
    });
  });

  it("does not call a change a revert when it only partly goes back", () => {
    // A -> C changed tagline and price; going to B restores only the price.
    const decision = evaluatePoll(listed(C, A), ok(B));
    expect(decision).toMatchObject({ changeKind: "content", summary: { kind: "llm" } });
  });

  describe("failed polls", () => {
    const state = listed(B, A);

    it.each<[string, Observation, string, string]>([
      ["an error", { kind: "error", reason: "timeout" }, "error", "timeout"],
      [
        "an incomplete listing",
        { kind: "incomplete", missing: ["price", "tagline"] },
        "incomplete",
        "missing:price,tagline",
      ],
    ])("records %s without touching the state", (_label, observation, status, reason) => {
      const decision = evaluatePoll(state, observation);
      expect(decision).toMatchObject({
        status,
        failureReason: reason,
        changed: false,
        changeKind: null,
        summary: { kind: "none" },
      });
      expect(decision.next).toBe(state);
    });

    it("still detects a change on the next good poll", () => {
      const decisions = run(
        [{ kind: "error", reason: "http_503" }, { kind: "incomplete", missing: ["price"] }, ok(C)],
        listed(A),
      );
      expect(decisions.map((d) => d.changed)).toEqual([false, false, true]);
      expect(decisions[2]).toMatchObject({ changeKind: "content", changedFields: ["tagline", "price"] });
    });
  });

  describe("an id the source does not know", () => {
    it("records not found without calling it a change, however often it repeats", () => {
      const decisions = run([NOT_FOUND, NOT_FOUND]);
      for (const decision of decisions) {
        expect(decision).toMatchObject({ status: "not_found", changed: false, changeKind: null });
        expect(decision.next.availability).toBe("unknown");
      }
    });

    it("starts a baseline when the listing appears later", () => {
      const decisions = run([NOT_FOUND, ok(A)]);
      expect(decisions[1]).toMatchObject({ changed: false, changeKind: "initial" });
    });
  });

  describe("delisting and relisting", () => {
    it("reports a delisting once, with a template summary", () => {
      const decisions = run([NOT_FOUND, NOT_FOUND], listed(A));
      expect(decisions[0]).toMatchObject({
        status: "not_found",
        changed: true,
        changeKind: "delisted",
        next: { availability: "delisted", current: A },
      });
      expect(decisions[0]?.summary).toEqual({
        kind: "template",
        text: 'The listing is no longer available at the source. It was last seen as "Acme CRM" at $39/mo.',
      });
      expect(decisions[1]).toMatchObject({ status: "not_found", changed: false, changeKind: null });
    });

    it("reports an unchanged relisting with a template summary", () => {
      const decisions = run([NOT_FOUND, ok(A)], listed(A));
      expect(decisions[1]).toMatchObject({
        status: "ok",
        changed: true,
        changeKind: "relisted",
        changedFields: [],
        summary: { kind: "template" },
        next: { availability: "listed", current: A },
      });
    });

    it("asks the LLM when the listing comes back different", () => {
      const decisions = run([NOT_FOUND, ok(C)], listed(A));
      expect(decisions[1]).toMatchObject({
        changed: true,
        changeKind: "relisted",
        changedFields: ["tagline", "price"],
        summary: { kind: "llm" },
        next: { availability: "listed", current: C, previous: A },
      });
    });

    it("ignores a failed poll while delisted", () => {
      const decisions = run([NOT_FOUND, { kind: "error", reason: "timeout" }, ok(A)], listed(A));
      expect(decisions.map((d) => d.changeKind)).toEqual(["delisted", null, "relisted"]);
    });
  });

  describe("sequences like the ones in the provided fixtures", () => {
    const llmCalls = (decisions: PollDecision[]) =>
      decisions.filter((d) => d.summary.kind === "llm").length;

    it("spends one LLM call on a tagline that flips between two versions five times", () => {
      const withReplay: Listing = { ...B, description: "Now with session replay." };
      const decisions = run([ok(A), ok(B), ok(A), ok(B), ok(A), ok(B), ok(withReplay), ok(withReplay)]);

      expect(decisions.map((d) => d.changeKind)).toEqual([
        "initial",
        "content",
        "revert",
        "revert",
        "revert",
        "revert",
        "content",
        null,
      ]);
      // The first flip and the real description change; the four flips back and forth are free.
      expect(llmCalls(decisions)).toBe(2);
    });

    it("handles a listing that disappears, returns unchanged, then raises its price", () => {
      const raised: Listing = { ...A, price: "$59/mo" };
      const decisions = run([ok(A), ok(A), NOT_FOUND, NOT_FOUND, ok(A), ok(raised)]);

      expect(decisions.map((d) => [d.changed, d.changeKind])).toEqual([
        [false, "initial"],
        [false, null],
        [true, "delisted"],
        [false, null],
        [true, "relisted"],
        [true, "content"],
      ]);
      expect(llmCalls(decisions)).toBe(1);
    });

    it("never reports a change for a listing that stays the same", () => {
      const decisions = run([ok(A), ok(A), ok(A), ok(A)]);
      expect(decisions.some((d) => d.changed)).toBe(false);
      expect(llmCalls(decisions)).toBe(0);
    });
  });
});
