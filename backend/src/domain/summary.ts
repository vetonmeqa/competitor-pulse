/**
 * Why a summary attempt did not produce a summary. Stored in `snapshots.summary_error`
 * and turned into a user-facing explanation by the API.
 */
export const SUMMARY_ERRORS = [
  /** The LLM did not answer within the timeout. */
  "llm_timeout",
  /** The LLM answered with an error, or could not be reached. */
  "llm_error",
  /** The LLM answered, but not with a usable summary. */
  "llm_invalid_response",
  /** Today's LLM call budget is used up. */
  "daily_cap_reached",
  /** The LLM has been failing, so calls are paused to protect the budget. */
  "llm_unavailable",
  /** Nobody could summarise the change while it was still recent. */
  "expired",
] as const;

export type SummaryError = (typeof SUMMARY_ERRORS)[number];

export function isSummaryError(value: string | null): value is SummaryError {
  return value !== null && (SUMMARY_ERRORS as readonly string[]).includes(value);
}
