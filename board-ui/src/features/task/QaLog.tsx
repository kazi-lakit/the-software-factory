import type { QaEntry } from "./qaEntries";

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/** Earlier questions with the answer given, its time and, when the question had a recommendation, whether it was followed. */
export function QaLog({ entries }: { entries: readonly QaEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ol className="sf-qa-log">
      {entries.map((entry, index) => (
        <li key={index} className="sf-qa-entry">
          <p className="sf-qa-question">{entry.question}</p>
          {entry.askedBy ? <p className="sf-muted sf-qa-asker">{entry.askedBy}</p> : null}
          {entry.answer === null ? (
            <p className="sf-muted">No answer recorded</p>
          ) : (
            <p className="sf-qa-answer">
              <span>{entry.answer}</span>
              {entry.mark === "recommended" ? <span className="sf-badge">Recommended</span> : null}
              {entry.mark === "not-recommended" ? <span className="sf-badge sf-badge-muted">Not recommended</span> : null}
            </p>
          )}
          {entry.answeredAt ? <time className="sf-muted sf-qa-time" dateTime={entry.answeredAt}>{formatTime(entry.answeredAt)}</time> : null}
        </li>
      ))}
    </ol>
  );
}
