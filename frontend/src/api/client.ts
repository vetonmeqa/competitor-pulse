import type { Competitor, Snapshot, SystemStatus } from "./types";

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
  return body as T;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface SnapshotQuery {
  limit: number;
  changedOnly: boolean;
}

export const api = {
  listCompetitors: (signal?: AbortSignal) =>
    request<Competitor[]>("/competitors", { signal: signal ?? null }),

  addCompetitor: (id: string) =>
    request<Competitor>("/competitors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),

  removeCompetitor: (id: string) =>
    request<undefined>(`/competitors/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listSnapshots: (id: string, query: SnapshotQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      limit: String(query.limit),
      changedOnly: String(query.changedOnly),
    });
    return request<Snapshot[]>(`/competitors/${encodeURIComponent(id)}/snapshots?${params}`, {
      signal: signal ?? null,
    });
  },

  getStatus: (signal?: AbortSignal) =>
    request<SystemStatus>("/status", { signal: signal ?? null }),
};
