import { useEffect, useRef, useState } from "react";
import styles from "./CopyButton.module.css";

interface CopyButtonProps {
  /** The text put on the clipboard. */
  value: string;
  /** What is being copied, for the accessible name: "Copy acme-crm". */
  label: string;
}

type CopyState = "idle" | "copied" | "failed";

/** How long the tick (or the failure mark) stays before the icon returns to normal. */
const FEEDBACK_MS = 2000;

/** A small icon button that copies a value to the clipboard and confirms it. */
export function CopyButton({ value, label }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  // Do not update state after the button has left the page.
  useEffect(
    () => () => {
      window.clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    let result: CopyState;
    try {
      // Unavailable on a page served over plain HTTP from another machine, and it can
      // be refused by the browser. Either way the user is told it did not work.
      await navigator.clipboard.writeText(value);
      result = "copied";
    } catch {
      result = "failed";
    }
    setState(result);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      setState("idle");
    }, FEEDBACK_MS);
  }

  return (
    <>
      <button
        className={styles.button}
        type="button"
        data-state={state}
        aria-label={`Copy ${label}`}
        title={state === "failed" ? "Could not copy" : "Copy to clipboard"}
        onClick={() => {
          void copy();
        }}
      >
        <Icon state={state} />
      </button>
      {/* Always in the page, so a screen reader announces the result when it appears. */}
      <span className="visually-hidden" role="status">
        {state === "copied" && `Copied ${label}`}
        {state === "failed" && `Could not copy ${label}`}
      </span>
    </>
  );
}

function Icon({ state }: { state: CopyState }) {
  const paths: Record<CopyState, string> = {
    // Two overlapping sheets.
    idle: "M9 9h10v11H9zM5 15V4h10",
    // A tick.
    copied: "M5 12.5l4.5 4.5L19 7.5",
    // A cross.
    failed: "M6 6l12 12M18 6L6 18",
  };
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[state]} />
    </svg>
  );
}
