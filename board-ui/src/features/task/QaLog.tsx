import { useId } from "react";
import { optionText } from "./parseQuestion";
import { answeredLine, qaCounts, qaLabelLine, type QaEntry } from "./qaEntries";

/** The task's questions and answers in one panel, newest first; the open question sits at the top. */
export function QaLog({ entries, nowMs = Date.now() }: { entries: readonly QaEntry[]; nowMs?: number }) {
  const headingId = useId();
  if (entries.length === 0) return null;
  const { asked, answered } = qaCounts(entries);
  return (
    <section className="sf-panel sf-qa-panel" aria-labelledby={headingId}>
      <div className="sf-qa-head">
        <h3 id={headingId}>Questions and answers</h3>
        <p className="sf-qa-counts">{asked} asked · {answered} answered</p>
      </div>
      <ol className="sf-qa-log">
        {entries.map((entry) => <QaItem key={entry.key} entry={entry} nowMs={nowMs} />)}
      </ol>
    </section>
  );
}

function QaItem({ entry, nowMs }: { entry: QaEntry; nowMs: number }) {
  const freeText = entry.answer !== null && !entry.options.some((option) => option.chosen);
  const answeredText = answeredLine(entry, nowMs);
  return (
    <li className={`sf-qa-entry${entry.open ? " sf-qa-entry-open" : ""}`}>
      {entry.open ? (
        <div className="sf-chips sf-qa-chips">
          {entry.answer === null ? <span className="sf-chip sf-chip-waiting">Waiting for your answer</span> : null}
          {entry.options.length > 0 ? <span className="sf-chip">{entry.options.length} options offered</span> : null}
        </div>
      ) : null}
      <p className="sf-qa-label">{qaLabelLine(entry, nowMs)}</p>
      <p className="sf-qa-question">{entry.question}</p>
      {entry.options.length > 0 ? (
        <ul className="sf-qa-options">
          {entry.options.map((option) => (
            <li key={option.letter} className={`sf-qa-option${option.chosen ? " sf-qa-option-chosen" : ""}`}>
              <span>{optionText(option)}</span>
              {option.recommended ? <span className="sf-chip sf-chip-waiting">Recommended</span> : null}
              {option.chosen ? <span className="sf-chip">Your answer</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {freeText ? (
        <div className="sf-qa-free">
          <span className="sf-qa-answer-label">Your answer</span>
          <p className="sf-qa-answer">{entry.answer}</p>
        </div>
      ) : null}
      {answeredText !== null ? (
        <p className="sf-muted sf-qa-answered">{answeredText}</p>
      ) : entry.open ? null : (
        <p className="sf-muted">No answer recorded</p>
      )}
    </li>
  );
}
