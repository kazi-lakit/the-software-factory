/** A timestamp in the viewer's locale; an unparseable value is shown as given. */
export const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const pad = (n: number): string => String(n).padStart(2, "0");

/** The date's local calendar day as YYYY-MM-DD. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A short local, 24-hour time: "Today 10:42", "Yesterday 17:05", otherwise "12 Nov 10:42".
 * An unparseable value is shown as given.
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = localDay(date);
  if (day === localDay(now)) return `Today ${time}`;
  if (day === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `Yesterday ${time}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

/** Like formatWhen, but today reads just "10:42" (no "Today " prefix). */
export function formatWhenShort(iso: string, now: Date = new Date()): string {
  return formatWhen(iso, now).replace(/^Today /, "");
}
