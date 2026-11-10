import { formatTime } from "../../lib/formatTime";
import type { QaEntry } from "./qaEntries";

/** Earlier questions with the answer given, its time and, when the question had a recommendation, whether it was followed. */
export function QaLog({ entries }: { entries: readonly QaEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ol className="sf-qa-log">
      {entries.map((entry) => (
        <li key={entry.key} className="sf-qa-entry">
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
