import { useId, useState } from "react";
import type { FormEvent } from "react";
import { answerTask, type Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { useUnsent } from "../../lib/unsent";
import { describeWriteError, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "./writeOutcome";

/** A blocked task's question and the owner's answer; the engine resumes the task once it sees the answer. */
export function AnswerPanel({ onReload, task }: { onReload: () => unknown; task: Task }) {
  const headingId = useId();
  const answerId = useId();
  const [text, setText, clear] = useUnsent(`answer:${task.taskId}`);
  const [problem, setProblem] = useState<WriteProblem>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateAfterWrite();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (text.trim() === "") {
      setProblem({ kind: "message", message: "Write an answer first." });
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await answerTask(boardStore, now, task.taskId, text);
      clear();
      setSent(true);
      void invalidate(task.taskId);
    } catch (error) {
      setProblem(describeWriteError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sf-panel sf-panel-needs-you" aria-labelledby={headingId}>
      <h3 id={headingId}>Blocked: your answer</h3>
      <dl className="sf-facts">
        <dt>Reason</dt>
        <dd>{task.blockedReason ?? "—"}</dd>
      </dl>
      {task.question ? <pre className="sf-doc-body">{task.question}</pre> : <p className="sf-empty">No question was given.</p>}
      {sent ? (
        <p role="status">Answer sent. The factory resumes the task at its next sync.</p>
      ) : task.answer ? (
        <p className="sf-muted">You answered: {task.answer}. The factory resumes the task at its next sync; a new answer replaces it.</p>
      ) : null}
      <form onSubmit={(event) => void submit(event)} aria-labelledby={headingId}>
        <label className="sf-field" htmlFor={answerId}>
          <span>Your answer</span>
          <textarea id={answerId} className="sf-input" rows={4} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <WriteProblemNotice problem={problem} onReload={() => void onReload()} />
        <div className="sf-actions">
          <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Send answer</button>
        </div>
      </form>
    </section>
  );
}
