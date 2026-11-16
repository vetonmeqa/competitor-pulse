import { formatDateTime, formatRelative } from "../lib/format";

interface TimestampProps {
  iso: string;
  /** `relative` shows "5 minutes ago" with the exact time as a tooltip. */
  format?: "absolute" | "relative";
}

/** A machine-readable `<time>`, shown in the viewer's own locale and time zone. */
export function Timestamp({ iso, format = "absolute" }: TimestampProps) {
  const absolute = formatDateTime(iso);
  return (
    <time dateTime={iso} title={format === "relative" ? absolute : undefined}>
      {format === "relative" ? formatRelative(iso) : absolute}
    </time>
  );
}
