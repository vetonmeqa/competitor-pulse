import { Link, Outlet } from "react-router";
import styles from "./Layout.module.css";
import { StatusFooter } from "./StatusFooter";

/** The frame around every page: header, the page itself, and the status footer. */
export function Layout() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.inner}>
          <Link className={styles.brand} to="/">
            <svg className={styles.logo} viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="8" fill="currentcolor" />
              <path
                d="M5 17h6l3-8 5 14 3-6h5"
                fill="none"
                stroke="var(--surface)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            CompetitorPulse
          </Link>
        </div>
      </header>
      <main id="main" className={styles.main}>
        <Outlet />
      </main>
      <StatusFooter />
    </div>
  );
}
