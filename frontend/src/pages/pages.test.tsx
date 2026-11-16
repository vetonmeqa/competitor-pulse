import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { competitor, mockApi, renderApp, snapshot, systemStatus } from "../test/helpers";

const status = () => ({ body: systemStatus });

describe("competitor list", () => {
  it("lists competitors and flags the ones that changed in the last 24 hours", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({
        body: [
          competitor({ id: "acme-crm", changedInLast24h: true }),
          competitor({ id: "orbit-hr", title: "Orbit HR", changedInLast24h: false }),
        ],
      }),
    });
    renderApp("/");

    const list = await screen.findByRole("list");
    const [acme, orbit] = within(list).getAllByRole("listitem");
    expect(within(acme as HTMLElement).getByRole("link", { name: "acme-crm" })).toHaveAttribute(
      "href",
      "/competitors/acme-crm",
    );
    expect(within(acme as HTMLElement).getByText("Changed in last 24 h")).toBeInTheDocument();
    expect(within(orbit as HTMLElement).getByText("Orbit HR")).toBeInTheDocument();
    expect(within(orbit as HTMLElement).queryByText("Changed in last 24 h")).not.toBeInTheDocument();
  });

  it("says so when nothing is tracked", async () => {
    mockApi({ "GET /status": status, "GET /competitors": () => ({ body: [] }) });
    renderApp("/");
    expect(await screen.findByText(/No competitors are tracked yet/)).toBeInTheDocument();
  });

  it("shows an error when the list cannot be loaded", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({
        status: 500,
        body: { error: { code: "internal_error", message: "Something went wrong." } },
      }),
    });
    renderApp("/");
    expect(await screen.findByRole("alert", { name: "" })).toBeInTheDocument();
    expect(
      await screen.findByText("Could not load the competitors: Something went wrong."),
    ).toBeInTheDocument();
  });

  it("removes a competitor after confirmation", async () => {
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor()] }),
      "DELETE /competitors/acme-crm": () => ({ status: 204 }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp("/");

    await userEvent.click(await screen.findByRole("button", { name: "Remove acme-crm" }));

    expect(confirm).toHaveBeenCalledWith('Stop tracking "acme-crm"? Its history will be deleted.');
    await waitFor(() => {
      expect(requests.some((request) => request.method === "DELETE")).toBe(true);
    });
  });

  it("does not remove anything when the user cancels", async () => {
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor()] }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("/");

    await userEvent.click(await screen.findByRole("button", { name: "Remove acme-crm" }));
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("shows the state of the backend in the footer", async () => {
    mockApi({ "GET /status": status, "GET /competitors": () => ({ body: [] }) });
    renderApp("/");

    const footer = await screen.findByRole("list", { name: "System status" });
    expect(footer).toHaveTextContent("Worker running");
    expect(footer).toHaveTextContent("2 tracked, polled every 15 min");
    expect(footer).toHaveTextContent("AI calls today: 12 of 2,000");
  });

  it("warns in the footer when the worker stopped or the budget is used up", async () => {
    mockApi({
      "GET /competitors": () => ({ body: [] }),
      "GET /status": () => ({
        body: {
          ...systemStatus,
          polling: { ...systemStatus.polling, oldestOverdueSeconds: 420 },
          summaries: { pending: 7, llmCallsToday: 2000, llmDailyCap: 2000 },
          worker: systemStatus.worker && { ...systemStatus.worker, running: false },
        },
      }),
    });
    renderApp("/");

    const footer = await screen.findByRole("list", { name: "System status" });
    expect(footer).toHaveTextContent("The worker is not running");
    expect(footer).toHaveTextContent("Polling is 7 min behind schedule");
    expect(footer).toHaveTextContent("AI calls today: 2,000 of 2,000 (budget used up)");
    expect(footer).toHaveTextContent("7 waiting for a summary");
  });
});

describe("competitor timeline", () => {
  const history = [
    snapshot({
      id: 3,
      fetchedAt: "2026-09-10T12:30:00.000Z",
      changed: true,
      changeKind: "content",
      changes: [{ field: "price", before: "$39/mo", after: "$29/mo" }],
      summary: "Price dropped from $39/mo to $29/mo.",
      summaryStatus: "done",
      summarySource: "llm",
      summaryReason: null,
    }),
    snapshot({ id: 2, fetchedAt: "2026-09-10T12:15:00.000Z", price: "$39/mo" }),
    snapshot({
      id: 1,
      fetchedAt: "2026-09-10T12:00:00.000Z",
      price: "$39/mo",
      changeKind: "initial",
      summaryReason: { code: "first_snapshot", message: "This is the first snapshot." },
    }),
  ];

  it("shows the snapshots in the order the API returns them, newest first", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor()] }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: history }),
    });
    renderApp("/competitors/acme-crm");

    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent("Price dropped from $39/mo to $29/mo.");
    expect(cards[1]).toHaveTextContent("No change");
    expect(cards[2]).toHaveTextContent("First snapshot");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("acme-crm");
  });

  it("asks the API for changes only when the filter is on, and remembers it in the URL", async () => {
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor()] }),
      "GET /competitors/acme-crm/snapshots": (request) => ({
        body: request.path.includes("changedOnly=true") ? history.slice(0, 1) : history,
      }),
    });
    const router = renderApp("/competitors/acme-crm");
    expect(await screen.findAllByRole("article")).toHaveLength(3);

    await userEvent.click(screen.getByRole("checkbox", { name: "Only show changes" }));

    await waitFor(() => {
      expect(screen.getAllByRole("article")).toHaveLength(1);
    });
    expect(requests.at(-1)?.path).toContain("changedOnly=true");
    expect(router.state.location.search).toBe("?show=changes");
  });

  it("starts filtered when opened from a link with the filter in it", async () => {
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor()] }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: history.slice(0, 1) }),
    });
    renderApp("/competitors/acme-crm?show=changes");

    expect(await screen.findByRole("checkbox", { name: "Only show changes" })).toBeChecked();
    expect(requests.find((request) => request.path.includes("/snapshots"))?.path).toContain(
      "changedOnly=true",
    );
  });

  it("offers older snapshots only when the page is full", async () => {
    const full = Array.from({ length: 50 }, (_unused, index) => snapshot({ id: 100 - index }));
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor()] }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: full }),
    });
    renderApp("/competitors/acme-crm");

    await userEvent.click(await screen.findByRole("button", { name: "Show older snapshots" }));
    await waitFor(() => {
      expect(requests.at(-1)?.path).toContain("limit=100");
    });
  });

  it("has no button for older snapshots when everything is already shown", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor()] }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: history }),
    });
    renderApp("/competitors/acme-crm");
    await screen.findAllByRole("article");
    expect(screen.queryByRole("button", { name: "Show older snapshots" })).not.toBeInTheDocument();
  });

  it("explains an empty history", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [competitor({ lastPolledAt: null })] }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: [] }),
    });
    renderApp("/competitors/acme-crm");
    expect(await screen.findByText(/No snapshots yet/)).toBeInTheDocument();
  });

  it("says when the competitor is not tracked, with a way back", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: [] }),
      "GET /competitors/nobody/snapshots": () => ({
        status: 404,
        body: { error: { code: "not_tracked", message: "This competitor is not tracked." } },
      }),
    });
    renderApp("/competitors/nobody");

    expect(await screen.findByText(/is not tracked/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the list" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("unknown address", () => {
  it("shows a not-found page with a link home", async () => {
    mockApi({ "GET /status": status });
    renderApp("/somewhere/else");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});
