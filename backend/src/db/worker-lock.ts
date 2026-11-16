import type pg from "pg";
import { pause } from "../util/pause.js";

const LOCK_NAME = "competitor-pulse:worker";

export interface WorkerLock {
  release(): Promise<void>;
}

export interface WorkerLockOptions {
  /** Stops waiting for the lock. */
  signal: AbortSignal;
  /** Called once if another worker holds the lock and we have to wait. */
  onWaiting?: () => void;
  /** Called if the connection that holds the lock breaks. The lock is gone at that point. */
  onLost: (error: Error) => void;
  retryMs?: number;
}

/**
 * Makes sure only one worker polls the source at a time.
 *
 * The rate limiter lives in the worker's memory, so two workers would each send at the
 * full rate and together break the source's limit. A Postgres advisory lock prevents
 * that: it belongs to one database connection and is released by Postgres itself when
 * that connection ends, including when the worker crashes. A second worker waits here
 * as a standby and takes over when the first one goes away.
 *
 * Returns null if `signal` aborts before the lock is obtained.
 *
 * Needs a direct or session-mode connection. A transaction-mode pooler (for example
 * PgBouncer in transaction mode) would hand the connection to another client between
 * queries and silently drop the lock.
 */
export async function acquireWorkerLock(
  pool: pg.Pool,
  options: WorkerLockOptions,
): Promise<WorkerLock | null> {
  const { signal, onWaiting, onLost, retryMs = 5000 } = options;
  const client = await pool.connect();
  let released = false;

  try {
    let announced = false;
    while (!signal.aborted) {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [LOCK_NAME],
      );
      if (result.rows[0]?.locked === true) {
        break;
      }
      if (!announced) {
        announced = true;
        onWaiting?.();
      }
      await pause(retryMs, signal);
    }
  } catch (error) {
    client.release(true);
    throw error;
  }

  if (signal.aborted) {
    // Closing the connection also drops the lock if the last attempt happened to win it.
    client.release(true);
    return null;
  }

  client.on("error", (error) => {
    if (!released) {
      onLost(error);
    }
  });

  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
        client.release();
      } catch {
        // The connection is already broken, so Postgres has released the lock for us.
        client.release(true);
      }
    },
  };
}
