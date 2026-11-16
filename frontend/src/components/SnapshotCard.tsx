import type { ListingField, Snapshot } from "../api/types";
import { CHANGE_KIND, FIELD_NAME, type Label, POLL_STATUS } from "../lib/labels";
import { Badge } from "./Badge";
import { Notice } from "./Notice";
import styles from "./SnapshotCard.module.css";
import { Timestamp } from "./Timestamp";

const LISTING_FIELDS: ListingField[] = ["title", "tagline", "price", "description"];

/** The one thing to know about this poll, shown as the card's badge. */
function headline(snapshot: Snapshot): Label {
  if (snapshot.changed) {
    const kind = snapshot.changeKind ?? "content";
    const tone = kind === "delisted" ? "danger" : kind === "relisted" ? "ok" : "info";
    return { text: CHANGE_KIND[kind], tone };
  }
  if (snapshot.status !== "ok") {
    return POLL_STATUS[snapshot.status];
  }
  return {
    text: snapshot.changeKind === "initial" ? CHANGE_KIND.initial : "No change",
    tone: "neutral",
  };
}

interface SnapshotCardProps {
  snapshot: Snapshot;
}

/** One poll in the timeline: when, what it found, what changed, and the summary. */
export function SnapshotCard({ snapshot }: SnapshotCardProps) {
  const badge = headline(snapshot);
  const hasListing = snapshot.status === "ok";

  return (
    <article className={styles.card} data-changed={snapshot.changed}>
      <header className={styles.header}>
        <h2 className={styles.time}>
          <Timestamp iso={snapshot.fetchedAt} />
        </h2>
        <span className={styles.ago}>
          <Timestamp iso={snapshot.fetchedAt} format="relative" />
        </span>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </header>

      <Summary snapshot={snapshot} />

      {snapshot.changes.length > 0 && (
        <section aria-label="What changed">
          <ul className={styles.changes}>
            {snapshot.changes.map((change) => (
              <li key={change.field} className={styles.change}>
                <span className={styles.field}>{FIELD_NAME[change.field]}</span>
                <span>
                  <span className="visually-hidden">changed from </span>
                  <del className={styles.before}>{change.before}</del>
                  <span aria-hidden="true"> → </span>
                  <span className="visually-hidden"> to </span>
                  <ins className={styles.after}>{change.after}</ins>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasListing && (
        <dl className={styles.listing}>
          {LISTING_FIELDS.map((field) => (
            <div key={field} className={styles.listingRow}>
              <dt>{FIELD_NAME[field]}</dt>
              <dd>{snapshot[field]}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

/** The summary, or a clear statement of why there is none. */
function Summary({ snapshot }: SnapshotCardProps) {
  if (snapshot.summary !== null) {
    return (
      <div className={styles.summary}>
        <p>{snapshot.summary}</p>
        <p className={styles.source}>
          {snapshot.summarySource === "llm"
            ? "AI summary"
            : "Automatic summary, written without AI"}
        </p>
      </div>
    );
  }

  const reason = snapshot.summaryReason?.message ?? "No summary is available.";

  // For a change, the missing summary is the news, so it gets a visible box. For a poll
  // where nothing changed, one quiet line is enough.
  if (snapshot.changed) {
    const waiting = snapshot.summaryStatus === "pending";
    return (
      <Notice tone={waiting ? "info" : "warn"}>
        {waiting && <span className={styles.pulse} aria-hidden="true" />}
        {reason}
      </Notice>
    );
  }
  return <p className={styles.reason}>{reason}</p>;
}
