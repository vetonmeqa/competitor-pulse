import { useState } from "react";
import { Link } from "react-router";
import { useRemoveCompetitor, useSetCompetitorPaused } from "../api/hooks";
import type { Competitor } from "../api/types";
import { competitorState } from "../lib/labels";
import { Badge } from "./Badge";
import styles from "./CompetitorList.module.css";
import { ConfirmDialog } from "./ConfirmDialog";
import { CopyButton } from "./CopyButton";
import { Notice } from "./Notice";
import { Timestamp } from "./Timestamp";

interface CompetitorListProps {
  competitors: Competitor[];
}

export function CompetitorList({ competitors }: CompetitorListProps) {
  const removeCompetitor = useRemoveCompetitor();
  const setPaused = useSetCompetitorPaused();
  // Removing also deletes the history, which cannot be undone, so ask first. This is the
  // id being asked about, or null when no question is open.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  return (
    <>
      {removeCompetitor.isError && (
        <Notice tone="danger" role="alert">
          Could not remove the competitor: {removeCompetitor.error.message}
        </Notice>
      )}
      {setPaused.isError && (
        <Notice tone="danger" role="alert">
          Could not {setPaused.variables.paused ? "pause" : "resume"} {setPaused.variables.id}:{" "}
          {setPaused.error.message}
        </Notice>
      )}
      <ul className={styles.list}>
        {competitors.map((competitor) => {
          const state = competitorState(competitor);
          const paused = competitor.pausedAt !== null;
          const removing = removeCompetitor.isPending && removeCompetitor.variables === competitor.id;
          const changingPause = setPaused.isPending && setPaused.variables.id === competitor.id;
          return (
            <li key={competitor.id} className={styles.item}>
              <div className={styles.identity}>
                <div className={styles.idRow}>
                  <Link
                    className={styles.id}
                    to={`/competitors/${encodeURIComponent(competitor.id)}`}
                  >
                    {competitor.id}
                  </Link>
                  <CopyButton value={competitor.id} label={competitor.id} />
                </div>
                {competitor.title !== null && (
                  <span className={styles.title}>{competitor.title}</span>
                )}
              </div>

              <div className={styles.badges}>
                <Badge tone={state.tone}>{state.text}</Badge>
                {paused && <Badge tone="neutral">Paused</Badge>}
                {competitor.changedInLast24h && <Badge tone="info">Changed in last 24 h</Badge>}
              </div>

              <p className={styles.polled}>
                {competitor.pausedAt !== null ? (
                  <>
                    Paused <Timestamp iso={competitor.pausedAt} format="relative" />
                  </>
                ) : competitor.lastPolledAt === null ? (
                  "Not polled yet"
                ) : (
                  <>
                    Polled <Timestamp iso={competitor.lastPolledAt} format="relative" />
                  </>
                )}
              </p>

              <div className={styles.actions}>
                {/* Pausing keeps the history and can be undone, so it does not ask first. */}
                <button
                  className={`button ${styles.pause}`}
                  type="button"
                  onClick={() => {
                    setPaused.mutate({ id: competitor.id, paused: !paused });
                  }}
                  disabled={changingPause}
                  // Every row has these buttons, so the name says which competitor it is for.
                  aria-label={`${paused ? "Resume" : "Pause"} ${competitor.id}`}
                >
                  {paused ? "Resume" : "Pause"}
                </button>
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() => {
                    setConfirmingId(competitor.id);
                  }}
                  disabled={removing}
                  aria-label={`Remove ${competitor.id}`}
                >
                  {removing ? "Removing…" : "Remove"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {confirmingId !== null && (
        <ConfirmDialog
          title={
            <>
              Stop tracking <span className={styles.confirmId}>{confirmingId}</span>?
            </>
          }
          confirmLabel="Remove"
          onConfirm={() => {
            removeCompetitor.mutate(confirmingId);
            setConfirmingId(null);
          }}
          onCancel={() => {
            setConfirmingId(null);
          }}
        >
          Its history will be deleted. This cannot be undone. To keep the history, pause it
          instead.
        </ConfirmDialog>
      )}
    </>
  );
}
