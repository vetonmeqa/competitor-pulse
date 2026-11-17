import { Link, type To } from "react-router";
import { formatCount } from "../lib/format";
import { pageSlots } from "../lib/pagination";
import styles from "./Pager.module.css";

interface PagerProps {
  /** The page being shown, from 1. */
  page: number;
  pageCount: number;
  /** Where the link for a page goes. */
  to: (page: number) => To;
  /** Called when the user picks another page, before the address changes. */
  onNavigate?: () => void;
}

/**
 * Previous, the page numbers, Next. Every item is a link, so a page can be opened in a
 * new tab or bookmarked, and the back button returns to the page before.
 *
 * A narrow screen has no room for the numbers and gets "Page 3 of 40" between the two
 * arrows.
 */
export function Pager({ page, pageCount, to, onNavigate }: PagerProps) {
  return (
    <nav className={styles.pager} aria-label="Pagination">
      <StepLink
        label="Previous page"
        to={to(Math.max(page - 1, 1))}
        disabled={page <= 1}
        onNavigate={onNavigate}
      >
        <Chevron direction="left" />
        <span className={styles.stepText}>Previous</span>
      </StepLink>

      <ol className={styles.pages}>
        {pageSlots(page, pageCount).map((slot) =>
          typeof slot === "number" ? (
            <li key={slot}>
              <Link
                className={styles.page}
                to={to(slot)}
                aria-label={`Page ${formatCount(slot)}`}
                aria-current={slot === page ? "page" : undefined}
                onClick={slot === page ? undefined : onNavigate}
              >
                {formatCount(slot)}
              </Link>
            </li>
          ) : (
            // Decoration only. The numbers on both sides already say pages are left out.
            <li key={slot} className={styles.gap} aria-hidden="true">
              …
            </li>
          ),
        )}
      </ol>
      <p className={styles.position}>
        Page {formatCount(page)} of {formatCount(pageCount)}
      </p>

      <StepLink
        label="Next page"
        to={to(Math.min(page + 1, pageCount))}
        disabled={page >= pageCount}
        onNavigate={onNavigate}
      >
        <span className={styles.stepText}>Next</span>
        <Chevron direction="right" />
      </StepLink>
    </nav>
  );
}

interface StepLinkProps {
  label: string;
  to: To;
  disabled: boolean;
  onNavigate: (() => void) | undefined;
  children: React.ReactNode;
}

/**
 * Previous or Next. At the first or last page it stays a link that does nothing, and is
 * not replaced by plain text: someone stepping through with the keyboard keeps the focus
 * on it when the last page arrives.
 */
function StepLink({ label, to, disabled, onNavigate, children }: StepLinkProps) {
  return (
    <Link
      className={`button ${styles.step}`}
      to={to}
      aria-label={label}
      aria-disabled={disabled ? "true" : undefined}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
        } else {
          onNavigate?.();
        }
      }}
    >
      {children}
    </Link>
  );
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      className={styles.chevron}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}
