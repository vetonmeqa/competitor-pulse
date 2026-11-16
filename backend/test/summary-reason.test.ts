import { describe, expect, it } from "vitest";
import { describeFailure, explainMissingSummary } from "../src/api/summary-reason.js";

type Fields = Parameters<typeof explainMissingSummary>[0];

const snapshot = (fields: Partial<Fields>): Fields => ({
  status: "ok",
  failureReason: null,
  changeKind: null,
  summaryStatus: "none",
  summaryError: null,
  ...fields,
});

describe("explainMissingSummary", () => {
  it("gives no reason when there is a summary", () => {
    expect(explainMissingSummary(snapshot({ summaryStatus: "done" }))).toBeNull();
  });

  it.each<[string, Partial<Fields>, string]>([
    ["an unchanged poll", {}, "no_change"],
    ["the first snapshot", { changeKind: "initial" }, "first_snapshot"],
    ["a failed poll", { status: "error", failureReason: "timeout" }, "poll_failed"],
    [
      "an incomplete listing",
      { status: "incomplete", failureReason: "missing:price" },
      "incomplete_listing",
    ],
    ["an unlisted competitor", { status: "not_found" }, "not_found"],
  ])("explains %s", (_label, fields, code) => {
    expect(explainMissingSummary(snapshot(fields))?.code).toBe(code);
  });

  it("says what went wrong with the poll", () => {
    expect(
      explainMissingSummary(snapshot({ status: "error", failureReason: "http_503" }))?.message,
    ).toBe("The poll failed (the source answered with HTTP 503), so there is nothing to compare.");
    expect(
      explainMissingSummary(snapshot({ status: "incomplete", failureReason: "missing:price,tagline" }))
        ?.message,
    ).toBe(
      "The source returned an incomplete listing (missing: price, tagline), so it was not compared.",
    );
  });

  describe("while a summary is pending", () => {
    const pending = (summaryError: string | null) =>
      explainMissingSummary(snapshot({ changeKind: "content", summaryStatus: "pending", summaryError }));

    it("says it is being generated before any attempt has failed", () => {
      expect(pending(null)).toEqual({
        code: "generating",
        message: "The summary is being generated.",
      });
    });

    it("says it is retrying after a failed attempt", () => {
      expect(pending("llm_timeout")).toEqual({
        code: "retrying",
        message:
          "The last attempt failed because the AI service took too long to answer. Trying again shortly.",
      });
      expect(pending("llm_invalid_response")?.code).toBe("retrying");
    });

    it("says when it is waiting for the daily budget to reset", () => {
      const reason = pending("daily_cap_reached");
      expect(reason?.code).toBe("daily_cap_reached");
      expect(reason?.message).toContain("after the budget resets at 00:00 UTC");
    });

    it("says when it is waiting for the AI service to recover", () => {
      expect(pending("llm_unavailable")?.code).toBe("llm_unavailable");
    });
  });

  describe("after giving up", () => {
    const failed = (summaryError: string | null) =>
      explainMissingSummary(snapshot({ changeKind: "content", summaryStatus: "failed", summaryError }));

    it.each(["llm_timeout", "llm_error", "llm_invalid_response", "expired"])(
      "keeps the cause: %s",
      (error) => {
        expect(failed(error)?.code).toBe(error);
      },
    );

    it("tells the user the change is still shown", () => {
      expect(failed("llm_timeout")?.message).toBe(
        "No summary: the AI service took too long to answer. The change itself is shown below.",
      );
    });

    it("falls back to a general error for a cause it does not know", () => {
      expect(failed("something_new")?.code).toBe("llm_error");
      expect(failed(null)?.code).toBe("llm_error");
    });
  });
});

describe("describeFailure", () => {
  it.each([
    ["timeout", "the source did not answer in time"],
    ["network", "the source could not be reached"],
    ["invalid_body", "the source returned something that is not a listing"],
    ["http_502", "the source answered with HTTP 502"],
    ["missing:description", "missing: description"],
    ["something_else", "something_else"],
    [null, "unknown reason"],
  ])("describes %j", (reason, expected) => {
    expect(describeFailure(reason)).toBe(expected);
  });
});
