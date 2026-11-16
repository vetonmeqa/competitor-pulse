import { afterAll, describe, expect, it } from "vitest";
import { acquireWorkerLock, type WorkerLock } from "../../src/db/worker-lock.js";
import { openTestDb, waitFor } from "./test-db.js";

const { pool } = openTestDb();

afterAll(async () => {
  await pool.end();
});

const never = new AbortController().signal;
const ignoreLoss = () => undefined;

describe("acquireWorkerLock", () => {
  it("lets a second worker in only after the first releases", async () => {
    const first = await acquireWorkerLock(pool, { signal: never, onLost: ignoreLoss });
    expect(first).not.toBeNull();

    let waiting = false;
    let second: WorkerLock | null | undefined;
    const standby = acquireWorkerLock(pool, {
      signal: never,
      onLost: ignoreLoss,
      onWaiting: () => {
        waiting = true;
      },
      retryMs: 20,
    }).then((lock) => {
      second = lock;
    });

    await waitFor(() => waiting);
    // Several retries later it is still waiting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second).toBeUndefined();

    await first?.release();
    await standby;
    expect(second).not.toBeNull();
    await second?.release();
  });

  it("stops waiting when asked to shut down", async () => {
    const holder = await acquireWorkerLock(pool, { signal: never, onLost: ignoreLoss });

    const shutdown = new AbortController();
    const standby = acquireWorkerLock(pool, {
      signal: shutdown.signal,
      onLost: ignoreLoss,
      retryMs: 20,
    });
    shutdown.abort();
    expect(await standby).toBeNull();

    await holder?.release();
  });

  it("can be taken again after a release, and releasing twice is harmless", async () => {
    const first = await acquireWorkerLock(pool, { signal: never, onLost: ignoreLoss });
    await first?.release();
    await first?.release();

    const second = await acquireWorkerLock(pool, { signal: never, onLost: ignoreLoss });
    expect(second).not.toBeNull();
    await second?.release();
  });

  it("is freed by Postgres when the holder's connection dies, and the holder is told", async () => {
    const crashed = openTestDb();
    let lost = false;
    const lock = await acquireWorkerLock(crashed.pool, {
      signal: never,
      onLost: () => {
        lost = true;
      },
    });

    // Kill the connection that holds the lock, as a crash or a network failure would.
    // Limited to this test database, so a worker running in development is not affected.
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_locks
       WHERE locktype = 'advisory' AND pid <> pg_backend_pid()
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    await waitFor(() => lost);

    // Nobody released it, yet the next worker gets it.
    const next = await acquireWorkerLock(pool, { signal: never, onLost: ignoreLoss, retryMs: 20 });
    expect(next).not.toBeNull();
    await next?.release();

    await lock?.release();
    await crashed.pool.end();
  });
});
