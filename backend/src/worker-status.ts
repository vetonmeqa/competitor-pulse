import { z } from "zod";
import type { Db } from "./db/client.js";
import { workerStatus } from "./db/schema.js";

/**
 * What the worker reports about itself. Written by the worker and read by the API, which
 * are separate processes, so the reader validates it like any other outside input.
 */
export const workerReportSchema = z.object({
  startedAt: z.string(),
  poller: z.object({
    inFlight: z.number(),
    /** Requests to the source since the worker started, by outcome. */
    polls: z.object({
      ok: z.number(),
      not_found: z.number(),
      incomplete: z.number(),
      error: z.number(),
      rate_limited: z.number(),
    }),
    rateLimiter: z.object({
      maxRatePerSecond: z.number(),
      currentRatePerSecond: z.number(),
      pausedForMs: z.number(),
      rateLimitedCount: z.number(),
    }),
  }),
  summarizer: z.object({
    provider: z.string(),
    /** Whether LLM calls are flowing (`closed`) or paused because the LLM is failing. */
    breaker: z.object({
      state: z.enum(["closed", "open", "half_open"]),
      consecutiveFailures: z.number(),
      retryInMs: z.number(),
    }),
    /** Summaries since the worker started, by outcome. */
    summaries: z.object({
      done: z.number(),
      retried: z.number(),
      failed: z.number(),
      deferredForCap: z.number(),
    }),
  }),
});

export type WorkerReport = z.infer<typeof workerReportSchema>;

export async function writeWorkerReport(db: Db, report: WorkerReport): Promise<void> {
  const row = { updatedAt: new Date(), report };
  await db
    .insert(workerStatus)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: workerStatus.id, set: row });
}

/** Returns null when no worker has ever reported, or the stored report is unreadable. */
export async function readWorkerReport(
  db: Db,
): Promise<{ updatedAt: Date; report: WorkerReport } | null> {
  const [row] = await db.select().from(workerStatus).limit(1);
  if (!row) {
    return null;
  }
  const parsed = workerReportSchema.safeParse(row.report);
  return parsed.success ? { updatedAt: row.updatedAt, report: parsed.data } : null;
}
