import { describe, expect, it } from "vitest";
import { competitor } from "../test/helpers";
import { competitorState } from "./labels";

describe("competitorState", () => {
  it.each([
    ["a listed competitor", competitor(), "Listed"],
    ["a delisted competitor", competitor({ availability: "delisted" }), "Delisted"],
    [
      "one that was just added",
      competitor({ availability: "unknown", lastPolledAt: null, lastPollStatus: null }),
      "Waiting for first poll",
    ],
    [
      "an id the source does not know",
      competitor({ availability: "unknown", lastPollStatus: "not_found" }),
      "Not found at source",
    ],
    [
      "one whose polls have all failed so far",
      competitor({ availability: "unknown", lastPollStatus: "error" }),
      "No listing yet",
    ],
  ])("labels %s", (_label, input, expected) => {
    expect(competitorState(input).text).toBe(expected);
  });
});
