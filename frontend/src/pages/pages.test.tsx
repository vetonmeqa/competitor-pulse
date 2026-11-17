import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  competitor,
  competitorPage,
  mockApi,
  renderApp,
  snapshot,
  systemStatus,
} from "../test/helpers";

const status = () => ({ body: systemStatus });

describe("competitor list", () => {
  it("lists competitors and flags the ones that changed in the last 24 hours", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({
        body: competitorPage([
          competitor({ id: "acme-crm", changedInLast24h: true }),
          competitor({ id: "orbit-hr", title: "Orbit HR", changedInLast24h: false }),
        ]),
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

  it("copies a competitor's id from its row", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /status": status,
      "GET /competitors": () => ({
        body: competitorPage([
          competitor({ id: "acme-crm" }),
          competitor({ id: "orbit-hr", title: "Orbit HR" }),
        ]),
      }),
    });
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Copy orbit-hr" }));

    expect(await navigator.clipboard.readText()).toBe("orbit-hr");
    expect(screen.getByText("Copied orbit-hr")).toBeInTheDocument();
    // Copying does not navigate or remove anything.
    expect(screen.getByRole("link", { name: "orbit-hr" })).toBeInTheDocument();
  });

  it("says so when nothing is tracked", async () => {
    mockApi({ "GET /status": status, "GET /competitors": () => ({ body: competitorPage([]) }) });
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
    const user = userEvent.setup();
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: competitorPage([competitor()]) }),
      "DELETE /competitors/acme-crm": () => ({ status: 204 }),
    });
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Remove acme-crm" }));

    const dialog = screen.getByRole("dialog", { name: "Stop tracking acme-crm?" });
    expect(dialog).toHaveAccessibleDescription(
      "Its history will be deleted. This cannot be undone.",
    );
    // Nothing is deleted until the user confirms.
    expect(requests.every((request) => request.method === "GET")).toBe(true);

    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(requests.some((request) => request.method === "DELETE")).toBe(true);
    });
  });

  it("does not remove anything when the user cancels", async () => {
    const user = userEvent.setup();
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors": () => ({ body: competitorPage([competitor()]) }),
    });
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Remove acme-crm" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "acme-crm" })).toBeInTheDocument();
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("shows the state of the backend in the footer", async () => {
    mockApi({ "GET /status": status, "GET /competitors": () => ({ body: competitorPage([]) }) });
    renderApp("/");

    const footer = await screen.findByRole("list", { name: "System status" });
    expect(footer).toHaveTextContent("Worker running");
    expect(footer).toHaveTextContent("2 tracked, polled every 15 min");
    expect(footer).toHaveTextContent("AI calls today: 12 of 2,000");
  });

  it("warns in the footer when the worker stopped or the budget is used up", async () => {
    mockApi({
      "GET /competitors": () => ({ body: competitorPage([]) }),
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

describe("competitor list, search and pages", () => {
  /** 60 competitors, c001 to c060, served the way the API pages and searches them. */
  const all = Array.from({ length: 60 }, (_unused, index) =>
    competitor({ id: `c${String(index + 1).padStart(3, "0")}`, title: `Company ${index + 1}` }),
  );
  function pagedApi(tracked = all) {
    return mockApi({
      "GET /status": status,
      "GET /competitors": (request) => {
        const params = new URLSearchParams(request.path.split("?")[1]);
        const q = params.get("q") ?? "";
        const pageSize = Number(params.get("pageSize"));
        const matching = tracked.filter((candidate) => candidate.id.includes(q));
        const lastPage = Math.max(1, Math.ceil(matching.length / pageSize));
        const page = Math.min(Number(params.get("page")), lastPage);
        return {
          body: competitorPage(matching.slice((page - 1) * pageSize, page * pageSize), {
            page,
            pageSize,
            total: matching.length,
            totalTracked: tracked.length,
          }),
        };
      },
    });
  }
  const rows = () =>
    within(screen.getByRole("list", { name: "" })).getAllByRole("listitem");
  const pager = () => screen.getByRole("navigation", { name: "Pagination" });

  it("shows the first page, how many there are, and the page numbers", async () => {
    const requests = pagedApi();
    renderApp("/");

    expect(await screen.findByRole("link", { name: "c001" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /^c\d+$/ })).toHaveLength(25);
    expect(screen.getByText("60 competitors")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–25 of 60")).toBeInTheDocument();
    expect(requests.find((request) => request.path.startsWith("/competitors"))?.path).toBe(
      "/competitors?page=1&pageSize=25",
    );

    expect(within(pager()).getByRole("link", { name: "Page 1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(pager()).getByRole("link", { name: "Page 3" })).toHaveAttribute(
      "href",
      "/?page=3",
    );
    expect(within(pager()).getByText("Page 1 of 3")).toBeInTheDocument();
    expect(within(pager()).getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("goes to another page and remembers it in the URL", async () => {
    const user = userEvent.setup();
    pagedApi();
    const router = renderApp("/");

    await user.click(await screen.findByRole("link", { name: "Next page" }));
    expect(await screen.findByRole("link", { name: "c026" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?page=2");
    expect(screen.getByText("Showing 26–50 of 60")).toBeInTheDocument();

    await user.click(within(pager()).getByRole("link", { name: "Page 3" }));
    expect(await screen.findByRole("link", { name: "c060" })).toBeInTheDocument();
    expect(screen.getByText("Showing 51–60 of 60")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "c026" })).not.toBeInTheDocument();

    // On the last page Next does nothing, and stays where it is.
    const next = within(pager()).getByRole("link", { name: "Next page" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    await user.click(next);
    expect(router.state.location.search).toBe("?page=3");

    // The first page has the plain address.
    await user.click(within(pager()).getByRole("link", { name: "Page 1" }));
    expect(await screen.findByRole("link", { name: "c001" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("");
  });

  it("opens on the page in the address", async () => {
    pagedApi();
    renderApp("/?page=2");
    expect(await screen.findByRole("link", { name: "c026" })).toBeInTheDocument();
    expect(within(pager()).getByRole("link", { name: "Page 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows the last page when the address asks for a page past the end", async () => {
    pagedApi();
    renderApp("/?page=99");
    expect(await screen.findByRole("link", { name: "c060" })).toBeInTheDocument();
    expect(within(pager()).getByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Showing 51–60 of 60")).toBeInTheDocument();
  });

  it("has no pager when everything fits on one page", async () => {
    pagedApi(all.slice(0, 3));
    renderApp("/");
    expect(await screen.findByText("3 competitors")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
  });

  it("searches on the server, not in the rows on screen", async () => {
    const user = userEvent.setup();
    const requests = pagedApi();
    const router = renderApp("/");
    await screen.findByRole("link", { name: "c001" });

    // c059 is on the third page, so it is not among the rows loaded so far.
    await user.type(screen.getByRole("searchbox", { name: "Search competitors" }), "c059");

    expect(await screen.findByText("1 of 60 competitors")).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "c059" })).toBeInTheDocument();
    expect(requests.at(-1)?.path).toBe("/competitors?page=1&pageSize=25&q=c059");
    expect(router.state.location.search).toBe("?q=c059");
    // One request for the word, not one for every letter typed.
    expect(requests.filter((request) => request.path.includes("q=")).length).toBe(1);
  });

  it("starts a new search on its first page and keeps the search while paging", async () => {
    const user = userEvent.setup();
    pagedApi();
    const router = renderApp("/?page=2");
    await screen.findByRole("link", { name: "c026" });

    // "c0" matches c001 to c060 too, so the matches still fill three pages.
    await user.type(screen.getByRole("searchbox"), "c0");
    await waitFor(() => {
      expect(router.state.location.search).toBe("?q=c0");
    });
    expect(await screen.findByRole("link", { name: "c001" })).toBeInTheDocument();

    await user.click(within(pager()).getByRole("link", { name: "Page 2" }));
    expect(await screen.findByRole("link", { name: "c026" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?q=c0&page=2");
  });

  it("opens with the search in the address, and clears it with the button", async () => {
    const user = userEvent.setup();
    pagedApi();
    const router = renderApp("/?q=c05");

    const box = await screen.findByRole("searchbox");
    expect(box).toHaveValue("c05");
    expect(await screen.findByText("10 of 60 competitors")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    expect(await screen.findByText("60 competitors")).toBeInTheDocument();
    expect(router.state.location.search).toBe("");
  });

  it("says so when nothing matches, with a way back to the whole list", async () => {
    const user = userEvent.setup();
    pagedApi();
    renderApp("/?q=zzz");

    expect(await screen.findByText(/No competitor matches “zzz”/)).toBeInTheDocument();
    expect(screen.getByText("0 of 60 competitors")).toBeInTheDocument();
    expect(screen.queryByText(/No competitors are tracked yet/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Clear the search" }));
    expect(await screen.findByText("60 competitors")).toBeInTheDocument();
    // The box follows a search that was changed from outside it.
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("has no search box when nothing is tracked", async () => {
    pagedApi([]);
    renderApp("/");
    expect(await screen.findByText(/No competitors are tracked yet/)).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
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

  const notTracked = () => ({
    status: 404,
    body: { error: { code: "not_tracked", message: "This competitor is not tracked." } },
  });

  it("shows the competitor's name and state above its history", async () => {
    const requests = mockApi({
      "GET /status": status,
      "GET /competitors/acme-crm": () => ({ body: competitor({ availability: "delisted" }) }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: history }),
    });
    renderApp("/competitors/acme-crm");

    const state = await screen.findByText("Delisted");
    expect(state.closest("p")).toHaveTextContent("Acme CRM");
    // It asks for this one competitor, not for the list, which is paged.
    expect(requests.map((request) => request.path)).not.toContain("/competitors");
  });

  it("shows the snapshots in the order the API returns them, newest first", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors/acme-crm": () => ({ body: competitor() }),
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
      "GET /competitors/acme-crm": () => ({ body: competitor() }),
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
      "GET /competitors/acme-crm": () => ({ body: competitor() }),
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
      "GET /competitors/acme-crm": () => ({ body: competitor() }),
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
      "GET /competitors/acme-crm": () => ({ body: competitor() }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: history }),
    });
    renderApp("/competitors/acme-crm");
    await screen.findAllByRole("article");
    expect(screen.queryByRole("button", { name: "Show older snapshots" })).not.toBeInTheDocument();
  });

  it("explains an empty history", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors/acme-crm": () => ({ body: competitor({ lastPolledAt: null }) }),
      "GET /competitors/acme-crm/snapshots": () => ({ body: [] }),
    });
    renderApp("/competitors/acme-crm");
    expect(await screen.findByText(/No snapshots yet/)).toBeInTheDocument();
  });

  it("says when the competitor is not tracked, with a way back", async () => {
    mockApi({
      "GET /status": status,
      "GET /competitors/nobody": notTracked,
      "GET /competitors/nobody/snapshots": notTracked,
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
