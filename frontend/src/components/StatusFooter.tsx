import { useSystemStatus } from "../api/hooks";
import type { SystemStatus } from "../api/types";
import { formatDuration } from "../lib/format";
import type { Tone } from "../lib/labels";
import styles from "./StatusFooter.module.css";

const count = new Intl.NumberFormat();

interface Item {
  text: string;
  tone?: Tone;
}

/** Turns the status into a few short statements, leading with anything that is wrong. */
function describe(status: SystemStatus): Item[] {
  const { polling, summaries, worker } = status;
  const items: Item[] = [];

  if (worker === null) {
    items.push({ text: "The worker has not started yet", tone: "warn" });
  } else if (!worker.running) {
    items.push({ text: "The worker is not running", tone: "danger" });
  } else {
    items.push({ text: "Worker running", tone: "ok" });
  }

  const paused = polling.paused > 0 ? ` (${count.format(polling.paused)} paused)` : "";
  items.push({
    text: `${count.format(polling.competitors)} tracked${paused}, polled every ${formatDuration(polling.intervalSeconds)}`,
  });
  if (polling.oldestOverdueSeconds !== null && polling.oldestOverdueSeconds > 60) {
    items.push({
      text: `Polling is ${formatDuration(polling.oldestOverdueSeconds)} behind schedule`,
      tone: "warn",
    });
  }

  if (worker !== null) {
    const { currentRatePerSecond, maxRatePerSecond } = worker.poller.rateLimiter;
    if (currentRatePerSecond < maxRatePerSecond) {
      items.push({
        text: `The source asked us to slow down (${currentRatePerSecond.toFixed(1)} of ${maxRatePerSecond} requests per second)`,
        tone: "warn",
      });
    }
    if (worker.summarizer.breaker.state !== "closed") {
      items.push({ text: "The AI service is not responding", tone: "warn" });
    }
  }

  const capReached = summaries.llmCallsToday >= summaries.llmDailyCap;
  items.push({
    text: `AI calls today: ${count.format(summaries.llmCallsToday)} of ${count.format(summaries.llmDailyCap)}${capReached ? " (budget used up)" : ""}`,
    ...(capReached ? { tone: "warn" as const } : {}),
  });
  if (summaries.pending > 0) {
    items.push({ text: `${count.format(summaries.pending)} waiting for a summary` });
  }
  return items;
}

/** A one-line health summary of the backend, at the bottom of every page. */
export function StatusFooter() {
  const { data: status, isError } = useSystemStatus();

  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        {status ? (
          <ul className={styles.items} aria-label="System status">
            {describe(status).map((item) => (
              <li key={item.text} className={styles.item} data-tone={item.tone}>
                {item.tone !== undefined && <span className={styles.dot} aria-hidden="true" />}
                {item.text}
              </li>
            ))}
          </ul>
        ) : (
          <p>{isError ? "The system status is unavailable." : "Loading system status…"}</p>
        )}
      </div>
    </footer>
  );
}
