import { type SubmitEvent, useId, useState } from "react";
import { useAddCompetitor } from "../api/hooks";
import styles from "./AddCompetitorForm.module.css";

/** The same rule the API enforces, checked here first for a quicker answer. */
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LENGTH = 100;

function validate(id: string): string | null {
  if (id === "") {
    return "Enter a competitor id.";
  }
  if (id.length > MAX_LENGTH) {
    return `An id can be at most ${MAX_LENGTH} characters.`;
  }
  if (!VALID_ID.test(id)) {
    return "Use letters, digits, dots, dashes and underscores, starting with a letter or digit.";
  }
  return null;
}

export function AddCompetitorForm() {
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const addCompetitor = useAddCompetitor();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  // A problem found here, or one the server reported for the last attempt.
  const error = validationError ?? addCompetitor.error?.message ?? null;

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = value.trim();
    const problem = validate(id);
    setValidationError(problem);
    if (problem !== null) {
      return;
    }
    addCompetitor.mutate(id, {
      onSuccess: () => {
        setValue("");
      },
    });
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <label className={styles.label} htmlFor={inputId}>
        Track a competitor
      </label>
      <div className={styles.row}>
        <input
          id={inputId}
          className={styles.input}
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setValidationError(null);
            addCompetitor.reset();
          }}
          placeholder="acme-crm"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
        />
        <button className="button button-primary" type="submit" disabled={addCompetitor.isPending}>
          {addCompetitor.isPending ? "Adding…" : "Add"}
        </button>
      </div>
      <p id={hintId} className={styles.hint}>
        Enter the id the source uses. The first poll runs within a few seconds.
      </p>
      {/* Always in the page, so a screen reader announces the message when it appears. */}
      <p id={errorId} className={styles.error} role="alert">
        {error}
      </p>
    </form>
  );
}
