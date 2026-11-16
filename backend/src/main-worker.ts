import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { acquireWorkerLock } from "./db/worker-lock.js";
import { createLogger } from "./logger.js";
import { PollStore } from "./poller/poll-store.js";
import { Poller } from "./poller/poller.js";
import { AdaptiveRateLimiter } from "./poller/rate-limiter.js";
import { runRetention } from "./poller/retention.js";
import { HttpListingSource } from "./source/http-listing-source.js";
import { pause } from "./util/pause.js";

const STATUS_LOG_INTERVAL_MS = 60_000;

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, "worker");
const { db, pool } = createDb(config.DATABASE_URL);

// One signal stops every loop. In-flight work is finished before the process exits.
const shutdown = new AbortController();
for (const signalName of ["SIGINT", "SIGTERM"] as const) {
  process.once(signalName, () => {
    log.info({ signal: signalName }, "shutting down");
    shutdown.abort();
  });
}

const lock = await acquireWorkerLock(pool, {
  signal: shutdown.signal,
  onWaiting: () => {
    log.info("another worker is active, waiting as standby");
  },
  onLost: (error) => {
    // Without the lock another worker may start polling, so stop rather than double the rate.
    log.fatal({ err: error }, "lost the worker lock, exiting");
    process.exit(1);
  },
});

if (lock !== null) {
  const store = new PollStore(db);
  const poller = new Poller({
    store,
    source: new HttpListingSource({
      baseUrl: config.SOURCE_BASE_URL,
      timeoutMs: config.SOURCE_TIMEOUT_MS,
    }),
    limiter: new AdaptiveRateLimiter({ maxRatePerSecond: config.SOURCE_RATE_LIMIT_PER_SEC }),
    log,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    maxInFlight: config.POLL_MAX_IN_FLIGHT,
  });

  log.info(
    {
      source: config.SOURCE_BASE_URL,
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
      rateLimitPerSecond: config.SOURCE_RATE_LIMIT_PER_SEC,
    },
    "worker started",
  );

  await Promise.all([
    poller.run(shutdown.signal),
    runRetention(store, config.RETENTION_DAYS, log, shutdown.signal),
    logStatus(poller, shutdown.signal),
  ]);

  await lock.release();
}

await pool.end();
log.info("worker stopped");

async function logStatus(poller: Poller, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await pause(STATUS_LOG_INTERVAL_MS, signal);
    log.info(poller.status(), "status");
  }
}
