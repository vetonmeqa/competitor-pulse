import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmUsage } from "../db/schema.js";

/**
 * The hard daily cap on LLM calls, counted per UTC day in the database.
 *
 * A call is reserved before it is made, and every attempt counts, including one that
 * then fails or times out: the request was sent, so it may have been billed.
 */
export class LlmBudget {
  private readonly db: Db;
  private readonly dailyCap: number;

  constructor(db: Db, dailyCap: number) {
    this.db = db;
    this.dailyCap = dailyCap;
  }

  /**
   * Takes one call from today's budget. Returns false when the cap is reached.
   *
   * One atomic statement: "add 1 only if still under the cap". Two workers asking at the
   * same moment can therefore never both take the last call.
   */
  async tryReserve(): Promise<boolean> {
    if (this.dailyCap <= 0) {
      return false;
    }
    const reserved = await this.db
      .insert(llmUsage)
      .values({ day: sql`(now() AT TIME ZONE 'utc')::date`, calls: 1 })
      .onConflictDoUpdate({
        target: llmUsage.day,
        set: { calls: sql`${llmUsage.calls} + 1` },
        setWhere: lt(llmUsage.calls, this.dailyCap),
      })
      .returning({ calls: llmUsage.calls });
    return reserved.length > 0;
  }
}

/** When today's budget resets: the next 00:00 UTC after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
