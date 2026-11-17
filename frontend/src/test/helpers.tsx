import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import type { Competitor, CompetitorPage, Snapshot, SystemStatus } from "../api/types";
import { routes } from "../App";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | undefined;
type Handler = (request: RecordedRequest) => Reply;

/**
 * Replaces `fetch` with a small in-memory API. Each key is "METHOD /path" (the path
 * without its query string); a request with no handler fails the test loudly.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = input.replace(/^\/api/, "");
      const request: RecordedRequest = {
        method,
        path,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      };
      requests.push(request);

      const handler = handlers[`${method} ${path.split("?")[0] ?? ""}`];
      if (!handler) {
        return Promise.reject(new Error(`Unexpected request: ${method} ${path}`));
      }
      const reply = handler(request) ?? {};
      const status = reply.status ?? 200;
      return Promise.resolve(
        new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status }),
      );
    }),
  );
  return requests;
}

function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** Renders one component with the providers it needs. */
export function renderWithProviders(ui: ReactElement) {
  const router = createMemoryRouter([{ path: "*", element: ui }]);
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Renders the whole app at `path`, with the real routes. */
export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

export function competitor(overrides: Partial<Competitor> = {}): Competitor {
  return {
    id: "acme-crm",
    createdAt: "2026-09-10T08:00:00.000Z",
    availability: "listed",
    title: "Acme CRM",
    lastPolledAt: "2026-09-10T12:00:00.000Z",
    lastPollStatus: "ok",
    lastChangedAt: null,
    changedInLast24h: false,
    ...overrides,
  };
}

/** A page of the list as the API returns it. By default the items are all there is. */
export function competitorPage(
  items: Competitor[],
  overrides: Partial<CompetitorPage> = {},
): CompetitorPage {
  return {
    items,
    page: 1,
    pageSize: 25,
    total: items.length,
    totalTracked: items.length,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 1,
    fetchedAt: "2026-09-10T12:00:00.000Z",
    status: "ok",
    statusDetail: null,
    title: "Acme CRM",
    tagline: "Simple CRM for small teams",
    price: "$29/mo",
    description: "Track leads and deals in one place.",
    changed: false,
    changeKind: null,
    changes: [],
    summary: null,
    summaryStatus: "none",
    summarySource: null,
    summaryReason: {
      code: "no_change",
      message: "Nothing that matters changed since the previous snapshot.",
    },
    ...overrides,
  };
}

export const systemStatus: SystemStatus = {
  now: "2026-09-10T12:00:00.000Z",
  polling: { competitors: 2, intervalSeconds: 900, overdue: 0, oldestOverdueSeconds: null },
  summaries: { pending: 0, llmCallsToday: 12, llmDailyCap: 2000 },
  worker: {
    running: true,
    lastSeenAt: "2026-09-10T11:59:55.000Z",
    poller: {
      rateLimiter: { maxRatePerSecond: 5, currentRatePerSecond: 5, rateLimitedCount: 0 },
    },
    summarizer: { provider: "openai-compatible (mock-llm)", breaker: { state: "closed" } },
  },
};
