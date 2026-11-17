import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  title: ReactNode;
  /** What will happen, in a sentence or two. */
  children: ReactNode;
  /** The text on the button that goes ahead, such as "Remove". */
  confirmLabel: string;
  onConfirm: () => void;
  /** Called for the Cancel button, the Esc key and a click outside the dialog. */
  onCancel: () => void;
}

/**
 * Asks the user to confirm an action that cannot be undone.
 *
 * Render it only while the question is open. It uses the browser's modal `<dialog>`, which
 * keeps focus inside, makes the rest of the page inert, closes on Esc, and gives focus
 * back to the button that opened it.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();

  // A layout effect, so the dialog is closed while it is still in the page. Only then
  // does the browser return focus to where it was.
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      // Lets a click outside close it, in browsers that support the attribute.
      closedby="any"
      // The browser closed it (Esc or a click outside), so the caller has to know. The
      // event arrives a moment after the dialog closes, so React's development mode, which
      // opens, closes and reopens it, delivers one while the dialog is open. Ignore that.
      onClose={(event) => {
        if (!event.currentTarget.open) {
          onCancel();
        }
      }}
    >
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>
      <p id={messageId} className={styles.message}>
        {children}
      </p>
      <div className={styles.actions}>
        {/* First in the dialog, so it gets the focus: Enter by reflex must not delete. */}
        <button className="button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className={`button ${styles.confirm}`} type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
