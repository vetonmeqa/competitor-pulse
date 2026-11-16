import type { Logger } from "../logger.js";
import { pause } from "../util/pause.js";
import type { PollStore } from "./poll-store.js";

const ONE_HOUR_MS = 60 * 60_000;

/**
 * Deletes snapshots older than the retention period, once at start and then hourly,
 * until `signal` aborts.
 *
 * A plain DELETE is fine at this size. At production volume (about half a million rows
 * a day) the table should be partitioned by time, so that retention is dropping a
 * partition instead of deleting rows.
 */
export async function runRetention(
  store: PollStore,
  retentionDays: number,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const deleted = await store.deleteSnapshotsOlderThan(retentionDays);
      if (deleted > 0) {
        log.info({ deleted, retentionDays }, "deleted snapshots past retention");
      }
    } catch (error) {
      log.error({ err: error }, "retention delete failed, will retry in an hour");
    }
    await pause(ONE_HOUR_MS, signal);
  }
}
