import { Fragment, useState, type MouseEvent } from "react";
import { markReady, type Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { parseQuestion } from "../task/parseQuestion";
import { describeWriteError, now, useInvalidateAfterWrite } from "../task/writeOutcome";
import { ctaLabel, MUTED, NEEDS_YOU, progressLabel, progressSteps, STATUS_LABEL, STEPS, taskPath } from "./status";
import type { BoardViewMode } from "./useBoardView";

/** A plain left click stays in the app; a modified or middle click is the browser's. */
export function followInApp(event: MouseEvent<HTMLAnchorElement>, href: string, onNavigate: (path: string) => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate(href);
}

/**
 * `showFactory` (the Board shows every factory) tags the id with the task's factory. `view` is the Board view the
 * card sits in: Lanes shows the status chip and the step bar; All stages (the column already says the status)
 * shows a chip only on cards that wait for the owner.
 */
export function TaskCard({ onNavigate, showFactory = false, task, view = "lanes", waitingOn = [] }: {
  onNavigate: (path: string) => void; showFactory?: boolean; task: Task; view?: BoardViewMode; waitingOn?: string[];
}) {
  const href = taskPath(task.taskId);
  const needsYou = NEEDS_YOU.has(task.status);
  const hasQuestion = task.status === "blocked" && !!task.question?.trim();
  const firstLine = task.status === "blocked" && task.question ? task.question.split("\n")[0]?.trim() : undefined;
  const tone = needsYou ? " sf-card-needs-you" : MUTED.has(task.status) ? " sf-card-muted" : "";
  const chip = view === "stages" ? (needsYou ? "Waiting for you" : null) : hasQuestion ? "Question" : STATUS_LABEL[task.status];
  const options = task.status === "blocked" && task.question ? parseQuestion(task.question).options.length : 0;
  const cta = options >= 2 ? `Answer (${options} options)` : ctaLabel(task.status, task.question);
  const showSteps = view === "lanes" && task.stage !== null;
  const steps = progressSteps(task.status, task.stage);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const invalidate = useInvalidateAfterWrite();

  async function ready() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await markReady(boardStore, now, task.taskId);
      void invalidate(task.taskId);
    } catch (e) {
      setError(describeWriteError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`sf-card${tone}`}>
      <div className="sf-card-top">
        <span className="sf-mono sf-card-id">{showFactory ? `${task.factoryId} · ${task.taskId}` : task.taskId}</span>
        {chip !== null ? <span className={`sf-card-status${needsYou ? " sf-card-status-waiting" : ""}`}>{chip}</span> : null}
      </div>
      {/* The title link covers the card (CSS), so the whole card opens the task. */}
      <a className="sf-card-link" href={href} onClick={(event) => followInApp(event, href, onNavigate)}>
        {task.title}
      </a>
      <div className="sf-card-meta">
        <span>{task.repo}</span>
        {showSteps ? (
          <span className="sf-steps" role="img" aria-label={progressLabel(task.status, task.stage)}>
            {steps.map((state, i) => (
              <span key={STEPS[i]} className="sf-step" data-state={state} title={STEPS[i]} />
            ))}
          </span>
        ) : null}
      </div>
      {waitingOn.length > 0 ? (
        <p className="sf-card-waiting">
          Waiting on{" "}
          {waitingOn.map((id, i) => (
            <Fragment key={id}>
              {i > 0 ? ", " : null}
              <a href={taskPath(id)} onClick={(event) => followInApp(event, taskPath(id), onNavigate)}>{id}</a>
            </Fragment>
          ))}
        </p>
      ) : null}
      {firstLine ? <p className="sf-card-question">{firstLine}</p> : null}
      {cta ? (
        <a className="sf-button sf-button-small sf-card-cta" href={href} onClick={(event) => followInApp(event, href, onNavigate)}>
          {cta}
        </a>
      ) : null}
      {task.status === "inbox" ? (
        <button type="button" className="sf-button sf-button-small sf-card-ready" disabled={busy} onClick={() => void ready()}>
          Mark ready
        </button>
      ) : null}
      {error ? <p className="sf-card-error" role="alert">{error}</p> : null}
    </article>
  );
}
