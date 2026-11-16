import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { acquireWorkerLock } from "./db/worker-lock.js";
import { createLogger } from "./logger.js";
import { PollStore } from "./poller/poll-store.js";
import { Poller } from "./poller/poller.js";
import { AdaptiveRateLimiter } from "./poller/rate-limiter.js";
import { runRetention } from "./poller/retention.js";
import { HttpListingSource } from "./source/http-listing-source.js";
import { LlmBudget } from "./summarizer/budget.js";
import { CircuitBreaker } from "./summarizer/circuit-breaker.js";
import { createProvider } from "./summarizer/create-provider.js";
import { Summarizer } from "./summarizer/summarizer.js";
import { SummaryStore } from "./summarizer/summary-store.js";
import { pause } from "./util/pause.js";
import { type WorkerReport, writeWorkerReport } from "./worker-status.js";

const STATUS_REPORT_INTERVAL_MS = 10_000;
/** Log the status once a minute, not on every report. */
const REPORTS_PER_LOG_LINE = 6;

const startedAt = new Date().toISOString();

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, "worker");
const { db, pool } = createDb(config.DATABASE_URL, 10, (error) => {
  log.warn({ err: error }, "an idle database connection was dropped");
});

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
  const summarizer = new Summarizer({
    store: new SummaryStore(db),
    provider: createProvider(config),
    budget: new LlmBudget(db, config.LLM_DAILY_CAP),
    breaker: new CircuitBreaker(),
    log,
    timeoutMs: config.LLM_TIMEOUT_MS,
    maxAttempts: config.LLM_MAX_ATTEMPTS,
    batchSize: config.LLM_BATCH_SIZE,
    concurrency: config.LLM_CONCURRENCY,
    maxAgeHours: config.SUMMARY_MAX_AGE_HOURS,
  });

  log.info(
    {
      source: config.SOURCE_BASE_URL,
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
      rateLimitPerSecond: config.SOURCE_RATE_LIMIT_PER_SEC,
      llm: summarizer.status().provider,
      llmDailyCap: config.LLM_DAILY_CAP,
      llmBatchSize: config.LLM_BATCH_SIZE,
    },
    "worker started",
  );

  // Polling and summarising are independent loops: a slow or failing LLM cannot delay a poll.
  await Promise.all([
    poller.run(shutdown.signal),
    summarizer.run(shutdown.signal),
    runRetention(store, config.RETENTION_DAYS, log, shutdown.signal),
    reportStatus(poller, summarizer, shutdown.signal),
  ]);

  await lock.release();
}

await pool.end();
log.info("worker stopped");

/**
 * Publishes the worker's live numbers to the database, where the API reads them. It also
 * works as a heartbeat: when the reports stop, the API shows the worker as not running.
 */
async function reportStatus(
  poller: Poller,
  summarizer: Summarizer,
  signal: AbortSignal,
): Promise<void> {
  for (let reports = 1; !signal.aborted; reports++) {
    const report: WorkerReport = {
      startedAt,
      poller: poller.status(),
      summarizer: summarizer.status(),
    };
    try {
      await writeWorkerReport(db, report);
    } catch (error) {
      log.warn({ err: error }, "could not write the worker status");
    }
    if (reports % REPORTS_PER_LOG_LINE === 0) {
      log.info(report, "status");
    }
    await pause(STATUS_REPORT_INTERVAL_MS, signal);
  }
}
