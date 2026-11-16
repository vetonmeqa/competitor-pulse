import type { SummaryError } from "../domain/summary.js";

export interface CompletionRequest {
  system: string;
  user: string;
  /** Aborts the call. The caller owns the timeout and passes it in here. */
  signal: AbortSignal;
}

/**
 * A language model that turns a prompt into text. Adapters do only the transport: send
 * the request, pull the text out of the response, and report failures as an `LlmError`.
 *
 * Everything that must behave the same for every provider stays with the caller: the
 * prompt, the timeout, the daily cap, retries, and judging whether the text is usable.
 * Adapters must not retry on their own, because every attempt counts against the cap.
 */
export interface LlmProvider {
  /** For logs, e.g. "openai-compatible (mock-llm)". */
  readonly name: string;
  complete(request: CompletionRequest): Promise<string>;
}

export type LlmErrorKind =
  /** The caller's signal aborted the call: a timeout, or the process shutting down. */
  | "aborted"
  /** No response at all: connection refused, DNS failure, dropped connection. */
  | "unreachable"
  /** The provider answered with an error status. */
  | "http"
  /** The provider answered, but not with usable text. */
  | "invalid_response";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmError";
    this.kind = kind;
  }
}

/** Maps a failed call to the reason stored with the snapshot and shown to the user. */
export function toSummaryError(error: LlmError): SummaryError {
  switch (error.kind) {
    case "aborted":
      return "llm_timeout";
    case "unreachable":
    case "http":
      return "llm_error";
    case "invalid_response":
      return "llm_invalid_response";
  }
}
