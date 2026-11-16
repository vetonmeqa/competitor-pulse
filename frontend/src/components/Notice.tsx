import type { ReactNode } from "react";
import type { Tone } from "../lib/labels";
import styles from "./Notice.module.css";

interface NoticeProps {
  tone?: Tone;
  /** `alert` interrupts a screen reader and is for errors; `status` waits its turn. */
  role?: "status" | "alert";
  children: ReactNode;
}

/** A boxed message: a loading state, an empty state, an error, or an explanation. */
export function Notice({ tone = "neutral", role, children }: NoticeProps) {
  return (
    <div className={styles.notice} data-tone={tone} role={role}>
      {children}
    </div>
  );
}
