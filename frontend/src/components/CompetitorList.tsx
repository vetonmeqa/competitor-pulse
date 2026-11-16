import { Link } from "react-router";
import { useRemoveCompetitor } from "../api/hooks";
import type { Competitor } from "../api/types";
import { competitorState } from "../lib/labels";
import { Badge } from "./Badge";
import styles from "./CompetitorList.module.css";
import { CopyButton } from "./CopyButton";
import { Notice } from "./Notice";
import { Timestamp } from "./Timestamp";

interface CompetitorListProps {
  competitors: Competitor[];
}

export function CompetitorList({ competitors }: CompetitorListProps) {
  const removeCompetitor = useRemoveCompetitor();

  function handleRemove(id: string) {
    // Removing also deletes the history, which cannot be undone, so ask first.
    if (window.confirm(`Stop tracking "${id}"? Its history will be deleted.`)) {
      removeCompetitor.mutate(id);
    }
  }

  return (
    <>
      {removeCompetitor.isError && (
        <Notice tone="danger" role="alert">
          Could not remove the competitor: {removeCompetitor.error.message}
        </Notice>
      )}
      <ul className={styles.list}>
        {competitors.map((competitor) => {
          const state = competitorState(competitor);
          const removing = removeCompetitor.isPending && removeCompetitor.variables === competitor.id;
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
                {competitor.changedInLast24h && <Badge tone="info">Changed in last 24 h</Badge>}
              </div>

              <p className={styles.polled}>
                {competitor.lastPolledAt === null ? (
                  "Not polled yet"
                ) : (
                  <>
                    Polled <Timestamp iso={competitor.lastPolledAt} format="relative" />
                  </>
                )}
              </p>

              <button
                className={`button button-danger ${styles.remove}`}
                type="button"
                onClick={() => {
                  handleRemove(competitor.id);
                }}
                disabled={removing}
                // Every row has a Remove button, so the name says which competitor it removes.
                aria-label={`Remove ${competitor.id}`}
              >
                {removing ? "Removing…" : "Remove"}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
