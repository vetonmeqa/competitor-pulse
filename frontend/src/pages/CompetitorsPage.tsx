import { useCompetitors } from "../api/hooks";
import { AddCompetitorForm } from "../components/AddCompetitorForm";
import { CompetitorList } from "../components/CompetitorList";
import { Notice } from "../components/Notice";
import styles from "./pages.module.css";

export function CompetitorsPage() {
  const { data: competitors, isPending, isError, error } = useCompetitors();

  return (
    <>
      <title>Competitors · CompetitorPulse</title>
      <div className={styles.heading}>
        <h1>Competitors</h1>
        <p className="muted">
          Each tracked listing is polled regularly. Open one to see its history and what changed.
        </p>
      </div>

      <AddCompetitorForm />

      <section className={styles.section} aria-label="Tracked competitors">
        {/* Shown next to the last good list, if there is one, so a failed refresh hides nothing. */}
        {isError && (
          <Notice tone="danger" role="alert">
            Could not load the competitors: {error.message}
          </Notice>
        )}
        {isPending && <Notice role="status">Loading competitors…</Notice>}
        {competitors?.length === 0 && (
          <Notice>No competitors are tracked yet. Add one above to get started.</Notice>
        )}
        {competitors !== undefined && competitors.length > 0 && (
          <CompetitorList competitors={competitors} />
        )}
      </section>
    </>
  );
}
