import type { Competitor, CompetitorPage, Snapshot, SystemStatus } from "./types";

/** A response the API answered with an error status, carrying its code and message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

/**
 * Calls the backend and returns the parsed body. The response types are trusted as
 * declared: both ends live in this repository and change together.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await send(path, init)).body as T;
}

/** Calls the backend and returns the parsed body with the response headers. */
async function send(path: string, init?: RequestInit): Promise<{ body: unknown; headers: Headers }> {
  const response = await fetch(`/api${path}`, init);
  const text = await response.text();
  const body: unknown = text === "" ? undefined : parseJson(text);

  if (!response.ok) {
    const error = (body as ErrorBody | undefined)?.error;
    throw new ApiError(
      response.status,
      typeof error?.code === "string" ? error.code : "unknown_error",
      typeof error?.message === "string"
        ? error.message
        : `The server answered with status ${response.status}.`,
    );
  }
  return { body, headers: response.headers };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface CompetitorQuery {
  page: number;
  pageSize: number;
  /** Text to find in the id or the title. Empty for no search. */
  search: string;
  /** Leaves out the competitors whose tracking is paused. */
  activeOnly: boolean;
}

export interface SnapshotQuery {
  limit: number;
  changedOnly: boolean;
  /** The id of a snapshot. Only the snapshots older than it are returned. */
  before?: number | undefined;
}

export const api = {
  /** The body is the plain array. The counts come in response headers. */
  listCompetitors: async (query: CompetitorQuery, signal?: AbortSignal): Promise<CompetitorPage> => {
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    if (query.search !== "") {
      params.set("q", query.search);
    }
    if (query.activeOnly) {
      params.set("activeOnly", "true");
    }
    const { body, headers } = await send(`/competitors?${params}`, { signal: signal ?? null });
    const count = (name: string) => Number(headers.get(name));
    return {
      items: body as Competitor[],
      page: count("x-page"),
      pageSize: count("x-page-size"),
      total: count("x-total-count"),
      totalTracked: count("x-total-tracked"),
    };
  },

  getCompetitor: (id: string, signal?: AbortSignal) =>
    request<Competitor>(`/competitors/${encodeURIComponent(id)}`, { signal: signal ?? null }),

  addCompetitor: (id: string) =>
    request<Competitor>("/competitors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),

  /** Stops the polling and keeps the history. Returns the competitor as it is now. */
  pauseCompetitor: (id: string) =>
    request<Competitor>(`/competitors/${encodeURIComponent(id)}/pause`, { method: "POST" }),

  resumeCompetitor: (id: string) =>
    request<Competitor>(`/competitors/${encodeURIComponent(id)}/resume`, { method: "POST" }),

  removeCompetitor: (id: string) =>
    request<undefined>(`/competitors/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listSnapshots: (id: string, query: SnapshotQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      limit: String(query.limit),
      changedOnly: String(query.changedOnly),
    });
    if (query.before !== undefined) {
      params.set("before", String(query.before));
    }
    return request<Snapshot[]>(`/competitors/${encodeURIComponent(id)}/snapshots?${params}`, {
      signal: signal ?? null,
    });
  },

  getStatus: (signal?: AbortSignal) =>
    request<SystemStatus>("/status", { signal: signal ?? null }),
};
