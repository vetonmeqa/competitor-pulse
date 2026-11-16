import { diffFields, type Listing, type ListingField, sameListing } from "./listing.js";
import { delistedSummary, relistedUnchangedSummary, revertSummary } from "./templates.js";

export type Availability = "unknown" | "listed" | "delisted";
export type PollStatus = "ok" | "not_found" | "incomplete" | "error";
export type ChangeKind = "initial" | "content" | "revert" | "delisted" | "relisted";

/** What one poll of the source saw. This is what gets recorded as a snapshot. */
export type Observation =
  | { kind: "ok"; listing: Listing }
  | { kind: "not_found" }
  | { kind: "incomplete"; missing: ListingField[] }
  | { kind: "error"; reason: string };

/** What we know about a competitor before a poll. */
export interface CompetitorState {
  availability: Availability;
  /** Last listing seen. Kept while delisted, so a relisting can be compared with it. */
  current: Listing | null;
  /** Listing before the last content change, used to recognise a revert. */
  previous: Listing | null;
}

export type SummaryPlan =
  /** Nothing to summarise. */
  | { kind: "none" }
  /** A fixed sentence says it exactly; no LLM call. */
  | { kind: "template"; text: string }
  /** Needs the LLM. */
  | { kind: "llm" };

export interface PollDecision {
  status: PollStatus;
  failureReason: string | null;
  changed: boolean;
  changeKind: ChangeKind | null;
  changedFields: ListingField[];
  summary: SummaryPlan;
  /** The competitor's state after this poll. */
  next: CompetitorState;
}

export const INITIAL_STATE: CompetitorState = {
  availability: "unknown",
  current: null,
  previous: null,
};

/**
 * Decides what one poll means for a competitor: is it a change that matters, and does
 * it need a summary. Pure: no I/O, no clock.
 *
 * A failed or incomplete poll never changes the state. We learned nothing reliable from
 * it, so the next good poll is still compared with the last good one.
 */
export function evaluatePoll(state: CompetitorState, observation: Observation): PollDecision {
  switch (observation.kind) {
    case "error":
      return noChange(state, "error", observation.reason);

    case "incomplete":
      return noChange(state, "incomplete", `missing:${observation.missing.join(",")}`);

    case "not_found":
      // Never seen, or already known to be gone: nothing new.
      if (state.availability !== "listed") {
        return noChange(state, "not_found", null);
      }
      return {
        status: "not_found",
        failureReason: null,
        changed: true,
        changeKind: "delisted",
        changedFields: [],
        summary: { kind: "template", text: delistedSummary(state.current) },
        next: { ...state, availability: "delisted" },
      };

    case "ok":
      return evaluateListing(state, observation.listing);

    default:
      return assertNever(observation);
  }
}

function evaluateListing(state: CompetitorState, listing: Listing): PollDecision {
  const { current, previous } = state;

  // First good listing: a baseline to compare later polls with, not a change.
  if (current === null) {
    return {
      status: "ok",
      failureReason: null,
      changed: false,
      changeKind: "initial",
      changedFields: [],
      summary: { kind: "none" },
      next: { availability: "listed", current: listing, previous: null },
    };
  }

  const changedFields = diffFields(current, listing);
  const contentChanged = changedFields.length > 0;
  const next: CompetitorState = contentChanged
    ? { availability: "listed", current: listing, previous: current }
    : { ...state, availability: "listed" };

  // Back after a 404. The return itself matters, even with identical content.
  if (state.availability === "delisted") {
    return {
      status: "ok",
      failureReason: null,
      changed: true,
      changeKind: "relisted",
      changedFields,
      summary: contentChanged
        ? { kind: "llm" }
        : { kind: "template", text: relistedUnchangedSummary() },
      next,
    };
  }

  if (!contentChanged) {
    return noChange(state, "ok", null);
  }

  // A -> B -> A. Typical of an A/B test or a rollback: real, but a template says it all.
  if (previous !== null && sameListing(previous, listing)) {
    return {
      status: "ok",
      failureReason: null,
      changed: true,
      changeKind: "revert",
      changedFields,
      summary: { kind: "template", text: revertSummary(current, listing, changedFields) },
      next,
    };
  }

  return {
    status: "ok",
    failureReason: null,
    changed: true,
    changeKind: "content",
    changedFields,
    summary: { kind: "llm" },
    next,
  };
}

function noChange(
  state: CompetitorState,
  status: PollStatus,
  failureReason: string | null,
): PollDecision {
  return {
    status,
    failureReason,
    changed: false,
    changeKind: null,
    changedFields: [],
    summary: { kind: "none" },
    next: state,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
