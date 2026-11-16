import type { SnapshotRow } from "../db/schema.js";
import { isSummaryError, type SummaryError } from "../domain/summary.js";

/** Why a snapshot has no summary. `code` is for programs, `message` is for people. */
export interface SummaryReason {
  code:
    | "no_change"
    | "first_snapshot"
    | "poll_failed"
    | "incomplete_listing"
    | "not_found"
    | "generating"
    | "retrying"
    | SummaryError;
  message: string;
}

type SummaryFields = Pick<
  SnapshotRow,
  "status" | "failureReason" | "changeKind" | "summaryStatus" | "summaryError"
>;

const LLM_PROBLEMS: Record<SummaryError, string> = {
  llm_timeout: "the AI service took too long to answer",
  llm_error: "the AI service returned an error",
  llm_invalid_response: "the AI service returned an unusable answer",
  daily_cap_reached: "the daily AI summary budget is used up",
  llm_unavailable: "the AI service is not responding",
  expired: "it could not be generated while the change was still recent",
};

/**
 * Explains why a snapshot has no summary, or returns null when it has one.
 *
 * Every snapshot without a summary gets a reason, so the UI never has to show an
 * unexplained blank.
 */
export function explainMissingSummary(snapshot: SummaryFields): SummaryReason | null {
  switch (snapshot.summaryStatus) {
    case "done":
      return null;

    case "none":
      return explainNotNeeded(snapshot);

    case "pending":
      return explainPending(snapshot.summaryError);

    case "failed": {
      const error = isSummaryError(snapshot.summaryError) ? snapshot.summaryError : "llm_error";
      return {
        code: error,
        message: `No summary: ${LLM_PROBLEMS[error]}. The change itself is shown below.`,
      };
    }
  }
}

function explainNotNeeded(snapshot: SummaryFields): SummaryReason {
  switch (snapshot.status) {
    case "error":
      return {
        code: "poll_failed",
        message: `The poll failed (${describeFailure(snapshot.failureReason)}), so there is nothing to compare.`,
      };
    case "incomplete":
      return {
        code: "incomplete_listing",
        message: `The source returned an incomplete listing (${describeFailure(snapshot.failureReason)}), so it was not compared.`,
      };
    case "not_found":
      return { code: "not_found", message: "The source does not list this competitor." };
    case "ok":
      return snapshot.changeKind === "initial"
        ? {
            code: "first_snapshot",
            message: "This is the first snapshot, so there is nothing to compare it with yet.",
          }
        : {
            code: "no_change",
            message: "Nothing that matters changed since the previous snapshot.",
          };
  }
}

function explainPending(error: string | null): SummaryReason {
  if (error === "daily_cap_reached") {
    return {
      code: error,
      message:
        "The daily AI summary budget is used up. This summary will be generated after the budget resets at 00:00 UTC.",
    };
  }
  if (error === "llm_unavailable") {
    return {
      code: error,
      message:
        "The AI service is not responding. This summary will be generated when it recovers.",
    };
  }
  if (isSummaryError(error)) {
    return {
      code: "retrying",
      message: `The last attempt failed because ${LLM_PROBLEMS[error]}. Trying again shortly.`,
    };
  }
  return { code: "generating", message: "The summary is being generated." };
}

/** Turns a stored failure reason such as "http_503" or "missing:price" into plain words. */
export function describeFailure(reason: string | null): string {
  if (reason === null) {
    return "unknown reason";
  }
  if (reason === "timeout") {
    return "the source did not answer in time";
  }
  if (reason === "network") {
    return "the source could not be reached";
  }
  if (reason === "invalid_body") {
    return "the source returned something that is not a listing";
  }
  if (reason.startsWith("http_")) {
    return `the source answered with HTTP ${reason.slice("http_".length)}`;
  }
  if (reason.startsWith("missing:")) {
    return `missing: ${reason.slice("missing:".length).split(",").join(", ")}`;
  }
  return reason;
}
