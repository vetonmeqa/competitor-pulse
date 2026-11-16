import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { useCompetitors, useSnapshots } from "../api/hooks";
import { Badge } from "../components/Badge";
import { Notice } from "../components/Notice";
import { SnapshotCard } from "../components/SnapshotCard";
import { competitorState } from "../lib/labels";
import styles from "./pages.module.css";

const PAGE_SIZE = 50;
/** The most the API returns in one request. */
const MAX_SNAPSHOTS = 1000;

export function TimelinePage() {
  const { id = "" } = useParams();
  // The filter lives in the URL, so a filtered view can be bookmarked and shared.
  const [searchParams, setSearchParams] = useSearchParams();
  const changedOnly = searchParams.get("show") === "changes";
  const [limit, setLimit] = useState(PAGE_SIZE);

  const snapshots = useSnapshots(id, { limit, changedOnly });
  const competitor = useCompetitors().data?.find((candidate) => candidate.id === id);
  const state = competitor ? competitorState(competitor) : null;

  const notTracked = snapshots.error instanceof ApiError && snapshots.error.status === 404;
  const list = snapshots.data;
  const mayHaveMore = list !== undefined && list.length >= limit && limit < MAX_SNAPSHOTS;

  return (
    <>
      <title>{`${id} · CompetitorPulse`}</title>
      <div className={styles.heading}>
        <Link className="small" to="/">
          ← All competitors
        </Link>
        <h1 className={styles.competitorId}>{id}</h1>
        {competitor && state && (
          <p className={styles.subtitle}>
            {competitor.title !== null && <span>{competitor.title}</span>}
            <Badge tone={state.tone}>{state.text}</Badge>
          </p>
        )}
      </div>

      {notTracked ? (
        <Notice tone="warn" role="alert">
          “{id}” is not tracked. It may have been removed. <Link to="/">Go to the list</Link> to
          add it.
        </Notice>
      ) : (
        <section className={styles.section} aria-label="History">
          <label className={styles.filter}>
            <input
              type="checkbox"
              checked={changedOnly}
              onChange={(event) => {
                setSearchParams(event.target.checked ? { show: "changes" } : {}, { replace: true });
              }}
            />
            Only show changes
          </label>

          {snapshots.isError && (
            <Notice tone="danger" role="alert">
              Could not load the history: {snapshots.error.message}
            </Notice>
          )}
          {snapshots.isPending && <Notice role="status">Loading history…</Notice>}
          {list?.length === 0 && (
            <Notice>
              {changedOnly
                ? "No changes have been recorded for this competitor yet."
                : "No snapshots yet. The first poll runs within a few seconds of adding a competitor."}
            </Notice>
          )}

          {list !== undefined && list.length > 0 && (
            <ol className={styles.timeline}>
              {list.map((snapshot) => (
                <li key={snapshot.id}>
                  <SnapshotCard snapshot={snapshot} />
                </li>
              ))}
            </ol>
          )}

          {mayHaveMore && (
            <button
              className={`button ${styles.more}`}
              type="button"
              disabled={snapshots.isPlaceholderData}
              onClick={() => {
                setLimit((current) => Math.min(current + PAGE_SIZE, MAX_SNAPSHOTS));
              }}
            >
              {snapshots.isPlaceholderData ? "Loading…" : "Show older snapshots"}
            </button>
          )}
        </section>
      )}
    </>
  );
}
