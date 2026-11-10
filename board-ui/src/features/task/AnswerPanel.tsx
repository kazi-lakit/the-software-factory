import { useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { answerTask, type FactoryEvent, type Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { useUnsent } from "../../lib/unsent";
import { optionText, parseQuestion, recommendedLetter } from "./parseQuestion";
import { askerName } from "./qaEntries";
import { describeWriteError, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "./writeOutcome";

const OTHER = "other";

/** The actor of the latest event that set a question: who is asking. */
function askerOf(events: readonly FactoryEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.field === "question" && event.to !== null) return askerName(event.actor);
  }
  return "";
}

/** A blocked task's question and the owner's answer; the engine resumes the task once it sees the answer. */
export function AnswerPanel(props: { events: readonly FactoryEvent[]; onReload: () => unknown; task: Task }) {
  // Keyed by question so a new question starts from its own recommendation, not the old selection.
  return <AnswerPanelBody key={`${props.task.taskId}:${props.task.question ?? ""}`} {...props} />;
}

function AnswerPanelBody({ events, onReload, task }: { events: readonly FactoryEvent[]; onReload: () => unknown; task: Task }) {
  const headingId = useId();
  const answerId = useId();
  const groupName = useId();
  const parsed = useMemo(() => parseQuestion(task.question ?? ""), [task.question]);
  const { options } = parsed;
  const recommended = recommendedLetter(options);
  const [text, setText, clear] = useUnsent(`answer:${task.taskId}`);
  const [choice, setChoice] = useState<string | null>(() => recommended ?? null);
  const [problem, setProblem] = useState<WriteProblem>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateAfterWrite();
  const asker = askerOf(events);
  const showTextarea = options.length === 0 || choice === OTHER;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const picked = options.find((option) => option.letter === choice);
    const payload = showTextarea ? text.trim() : picked ? optionText(picked) : "";
    if (payload === "") {
      setProblem({ kind: "message", message: "Write an answer first." });
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await answerTask(boardStore, now, task.taskId, payload, task.version);
      clear();
      setSent(true);
      void invalidate(task.taskId);
    } catch (error) {
      setProblem(describeWriteError(error));
    } finally {
      setBusy(false);
    }
  }

  const [headingLine = "", ...more] = parsed.prompt.split("\n");
  const restLines = more.join("\n").trim();

  return (
    <section className="sf-panel sf-panel-needs-you" aria-labelledby={headingId}>
      {task.question ? (
        <>
          <h3 id={headingId} className="sf-question-title">{headingLine || "Choose an answer"}</h3>
          {restLines ? <p className="sf-question-more">{restLines}</p> : null}
          {asker ? <p className="sf-muted sf-asker" data-testid="asker">{asker}</p> : null}
        </>
      ) : (
        <>
          <h3 id={headingId}>Blocked: your answer</h3>
          <p className="sf-empty">No question was given.</p>
        </>
      )}
      <dl className="sf-facts">
        <dt>Reason</dt>
        <dd>{task.blockedReason ?? "—"}</dd>
      </dl>
      {sent ? (
        <p role="status">Answer sent. The factory resumes the task at its next sync.</p>
      ) : task.answer ? (
        <p className="sf-muted">You answered: {task.answer}. The factory resumes the task at its next sync; a new answer replaces it.</p>
      ) : null}
      <form onSubmit={(event) => void submit(event)} aria-labelledby={headingId}>
        {options.length > 0 ? (
          <div className="sf-radio-cards" role="radiogroup" aria-labelledby={headingId}>
            {options.map((option) => (
              <label key={option.letter} className={`sf-radio-card${choice === option.letter ? " sf-radio-card-selected" : ""}`}>
                <input type="radio" name={groupName} value={option.letter} checked={choice === option.letter} disabled={busy} onChange={() => setChoice(option.letter)} />
                <span className="sf-radio-body">
                  <span className="sf-radio-label">
                    {option.label}
                    {recommended === option.letter ? <span className="sf-badge">Recommended</span> : null}
                  </span>
                  {option.why ? <span className="sf-radio-why">{option.why}</span> : null}
                </span>
              </label>
            ))}
            <label className={`sf-radio-card${choice === OTHER ? " sf-radio-card-selected" : ""}`}>
              <input type="radio" name={groupName} value={OTHER} checked={choice === OTHER} disabled={busy} onChange={() => setChoice(OTHER)} />
              <span className="sf-radio-body">
                <span className="sf-radio-label">Other</span>
                <span className="sf-radio-why">Write your own answer</span>
              </span>
            </label>
          </div>
        ) : null}
        {showTextarea ? (
          <label className="sf-field" htmlFor={answerId}>
            <span>Your answer</span>
            <textarea id={answerId} className="sf-input" rows={4} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
          </label>
        ) : null}
        <WriteProblemNotice problem={problem} onReload={() => void onReload()} />
        <div className="sf-actions sf-action-bar">
          <button type="submit" className="sf-button sf-button-accent" disabled={busy}>Send answer</button>
        </div>
      </form>
    </section>
  );
}
