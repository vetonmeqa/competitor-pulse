import { setTimeout as sleep } from "node:timers/promises";

/**
 * Waits for `ms`, or returns early when `signal` aborts. Never rejects, so a background
 * loop can use it between iterations and simply re-check the signal afterwards.
 */
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    // Aborted: return early.
  }
}
