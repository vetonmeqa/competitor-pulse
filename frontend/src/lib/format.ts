const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const count = new Intl.NumberFormat();

/** "6,000" in the viewer's locale. */
export function formatCount(value: number): string {
  return count.format(value);
}

/** "10 Sep 2026, 12:00:05" in the viewer's locale and time zone. */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/** "5 minutes ago", "2 hours ago", "yesterday". Anything under a minute is "just now". */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.trunc(seconds / size), unit);
    }
  }
  return "just now";
}

/** "45 s", "5 min", "2 h 10 min". For durations such as how far behind a queue is. */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}
