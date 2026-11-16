import type { ReactNode } from "react";
import type { Tone } from "../lib/labels";
import styles from "./Badge.module.css";

interface BadgeProps {
  tone: Tone;
  children: ReactNode;
}

/** A short status label. The text carries the meaning; the colour only supports it. */
export function Badge({ tone, children }: BadgeProps) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}
