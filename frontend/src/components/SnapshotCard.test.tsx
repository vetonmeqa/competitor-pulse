import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { snapshot } from "../test/helpers";
import { SnapshotCard } from "./SnapshotCard";

const priceChange = {
  changed: true,
  changeKind: "content" as const,
  changes: [{ field: "price" as const, before: "$39/mo", after: "$29/mo" }],
};

describe("SnapshotCard", () => {
  it("shows the fetched time and the four listing fields", () => {
    render(<SnapshotCard snapshot={snapshot()} />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/2026/);
    const term = (name: string) => screen.getByText(name).closest("div");
    expect(term("Title")).toHaveTextContent("Acme CRM");
    expect(term("Tagline")).toHaveTextContent("Simple CRM for small teams");
    expect(term("Price")).toHaveTextContent("$29/mo");
    expect(term("Description")).toHaveTextContent("Track leads and deals in one place.");
  });

  it("says why an unchanged snapshot has no summary", () => {
    render(<SnapshotCard snapshot={snapshot()} />);
    expect(screen.getByText("No change")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing that matters changed since the previous snapshot."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "What changed" })).not.toBeInTheDocument();
  });

  it("shows an AI summary with its source and the change behind it", () => {
    render(
      <SnapshotCard
        snapshot={snapshot({
          ...priceChange,
          summary: "Price dropped from $39/mo to $29/mo.",
          summaryStatus: "done",
          summarySource: "llm",
          summaryReason: null,
        })}
      />,
    );

    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.getByText("Price dropped from $39/mo to $29/mo.")).toBeInTheDocument();
    expect(screen.getByText("AI summary")).toBeInTheDocument();
    const changes = screen.getByRole("region", { name: "What changed" });
    expect(within(changes).getByText("$39/mo")).toBeInTheDocument();
    expect(within(changes).getByText("$29/mo")).toBeInTheDocument();
  });

  it("marks a template summary as written without AI", () => {
    render(
      <SnapshotCard
        snapshot={snapshot({
          changed: true,
          changeKind: "revert",
          summary: "Reverted to the previous version.",
          summaryStatus: "done",
          summarySource: "template",
          summaryReason: null,
        })}
      />,
    );
    expect(screen.getByText("Reverted")).toBeInTheDocument();
    expect(screen.getByText("Automatic summary, written without AI")).toBeInTheDocument();
  });

  it.each([
    ["is still being generated", "pending", "The summary is being generated."],
    [
      "is waiting for the daily budget",
      "pending",
      "The daily AI summary budget is used up. This summary will be generated after the budget resets at 00:00 UTC.",
    ],
    [
      "could not be generated",
      "failed",
      "No summary: the AI service took too long to answer. The change itself is shown below.",
    ],
  ] as const)("explains a change whose summary %s, and still shows the change", (_l, status, message) => {
    render(
      <SnapshotCard
        snapshot={snapshot({
          ...priceChange,
          summaryStatus: status,
          summaryReason: { code: "any", message },
        })}
      />,
    );

    expect(screen.getByText(message)).toBeInTheDocument();
    const changes = screen.getByRole("region", { name: "What changed" });
    expect(changes).toHaveTextContent("changed from $39/mo");
    expect(changes).toHaveTextContent("to $29/mo");
  });

  it("shows a failed poll with its reason and no listing fields", () => {
    render(
      <SnapshotCard
        snapshot={snapshot({
          status: "error",
          statusDetail: "timeout",
          title: null,
          tagline: null,
          price: null,
          description: null,
          summaryReason: {
            code: "poll_failed",
            message: "The poll failed (the source did not answer in time), so there is nothing to compare.",
          },
        })}
      />,
    );

    expect(screen.getByText("Poll failed")).toBeInTheDocument();
    expect(screen.getByText(/the source did not answer in time/)).toBeInTheDocument();
    expect(screen.queryByText("Tagline")).not.toBeInTheDocument();
  });

  it.each([
    ["delisted", "not_found", "Delisted"],
    ["relisted", "ok", "Relisted"],
  ] as const)("labels a %s competitor", (changeKind, status, label) => {
    render(
      <SnapshotCard
        snapshot={snapshot({
          status,
          changed: true,
          changeKind,
          summary: "A template summary.",
          summaryStatus: "done",
          summarySource: "template",
          summaryReason: null,
        })}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("falls back to a generic line if the API sends no reason", () => {
    render(<SnapshotCard snapshot={snapshot({ summaryReason: null })} />);
    expect(screen.getByText("No summary is available.")).toBeInTheDocument();
  });
});
