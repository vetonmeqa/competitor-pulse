import type { ChangeKind, Competitor, ListingField, PollStatus } from "../api/types";

/** The visual weight of a badge. Each tone always comes with a text label, never colour alone. */
export type Tone = "neutral" | "ok" | "info" | "warn" | "danger";

export interface Label {
  text: string;
  tone: Tone;
}

/** Where a competitor stands right now, for the list view. */
export function competitorState(competitor: Competitor): Label {
  switch (competitor.availability) {
    case "listed":
      return { text: "Listed", tone: "ok" };
    case "delisted":
      return { text: "Delisted", tone: "danger" };
    case "unknown":
      if (competitor.lastPolledAt === null) {
        return { text: "Waiting for first poll", tone: "neutral" };
      }
      return competitor.lastPollStatus === "not_found"
        ? { text: "Not found at source", tone: "warn" }
        : { text: "No listing yet", tone: "warn" };
  }
}

export const POLL_STATUS: Record<PollStatus, Label> = {
  ok: { text: "Fetched", tone: "ok" },
  not_found: { text: "Not found", tone: "warn" },
  incomplete: { text: "Incomplete", tone: "warn" },
  error: { text: "Poll failed", tone: "danger" },
};

export const CHANGE_KIND: Record<ChangeKind, string> = {
  initial: "First snapshot",
  content: "Changed",
  revert: "Reverted",
  delisted: "Delisted",
  relisted: "Relisted",
};

export const FIELD_NAME: Record<ListingField, string> = {
  title: "Title",
  tagline: "Tagline",
  price: "Price",
  description: "Description",
};
