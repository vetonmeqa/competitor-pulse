import { type SubmitEvent, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import styles from "./SearchField.module.css";

interface SearchFieldProps {
  /** The search in effect, as the page knows it (from the address bar). */
  query: string;
  /** Called with the trimmed text a moment after the user stops typing. */
  onQueryChange: (query: string) => void;
  label: string;
  placeholder: string;
}

/** How long to wait after the last keystroke, so typing a word is one request, not five. */
const DEBOUNCE_MS = 300;

/** A search box that searches as the user types. */
export function SearchField({ query, onQueryChange, label, placeholder }: SearchFieldProps) {
  const [text, setText] = useState(query);
  // The last search this field asked for. It is ahead of `query` for a moment after typing.
  const [asked, setAsked] = useState(query);
  const [lastQuery, setLastQuery] = useState(query);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // `query` changed. If it is what this field asked for, the typing is simply taking
  // effect. If not, it came from outside (a link, the back button) and the box follows it.
  if (query !== lastQuery) {
    setLastQuery(query);
    if (query !== asked) {
      setAsked(query);
      setText(query);
    }
  }

  function ask(value: string) {
    setAsked(value);
    if (value !== asked) {
      onQueryChange(value);
    }
  }

  const askAfterPause = useEffectEvent(ask);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      askAfterPause(text.trim());
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text]);

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    // Enter searches at once, without waiting for the pause.
    event.preventDefault();
    ask(text.trim());
  }

  return (
    <form className={styles.field} role="search" onSubmit={handleSubmit}>
      <label className="visually-hidden" htmlFor={inputId}>
        {label}
      </label>
      <svg
        className={styles.icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <input
        ref={input}
        id={inputId}
        className={styles.input}
        type="search"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="search"
      />
      {text !== "" && (
        <button
          className={styles.clear}
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setText("");
            ask("");
            input.current?.focus();
          }}
        >
          <svg
            className={styles.clearIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      )}
    </form>
  );
}
