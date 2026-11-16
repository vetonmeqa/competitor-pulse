import { Link } from "react-router";
import styles from "./pages.module.css";

export function NotFoundPage() {
  return (
    <>
      <title>Page not found · CompetitorPulse</title>
      <div className={styles.heading}>
        <h1>Page not found</h1>
        <p className="muted">
          There is nothing at this address. <Link to="/">Go to the competitor list.</Link>
        </p>
      </div>
    </>
  );
}
