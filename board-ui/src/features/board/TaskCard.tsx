import type { MouseEvent } from "react";
import type { Task } from "@factory/core";
import { ctaLabel, MUTED, NEEDS_YOU, progressLabel, progressSteps, STATUS_LABEL, STEPS, taskPath } from "./status";

/** A plain left click stays in the app; a modified or middle click is the browser's. */
export function followInApp(event: MouseEvent<HTMLAnchorElement>, href: string, onNavigate: (path: string) => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate(href);
}

/** `showFactory` (the Board shows every factory) tags the id with the task's factory. */
export function TaskCard({ onNavigate, showFactory = false, task, waitingOn = [] }: { onNavigate: (path: string) => void; showFactory?: boolean; task: Task; waitingOn?: string[] }) {
  const href = taskPath(task.taskId);
  const needsYou = NEEDS_YOU.has(task.status);
  const firstLine = task.status === "blocked" && task.question ? task.question.split("\n")[0]?.trim() : undefined;
  const tone = needsYou ? " sf-card-needs-you" : MUTED.has(task.status) ? " sf-card-muted" : "";
  const cta = ctaLabel(task.status, task.question);
  const steps = progressSteps(task.status, task.stage);

  return (
    <article className={`sf-card${tone}`}>
      <div className="sf-card-top">
        <span className="sf-mono sf-card-id">{showFactory ? `${task.factoryId} · ${task.taskId}` : task.taskId}</span>
        <span className={`sf-card-status${needsYou ? " sf-card-status-waiting" : ""}`}>{STATUS_LABEL[task.status]}</span>
      </div>
      {/* The title link covers the card (CSS), so the whole card opens the task. */}
      <a className="sf-card-link" href={href} onClick={(event) => followInApp(event, href, onNavigate)}>
        {task.title}
      </a>
      <div className="sf-card-meta">
        <span>{task.repo}</span>
        <span className="sf-steps" role="img" aria-label={progressLabel(task.status, task.stage)}>
          {steps.map((state, i) => (
            <span key={STEPS[i]} className="sf-step" data-state={state} title={STEPS[i]} />
          ))}
        </span>
      </div>
      {waitingOn.length > 0 ? <p className="sf-card-waiting">Waiting on {waitingOn.join(", ")}</p> : null}
      {firstLine ? <p className="sf-card-question">{firstLine}</p> : null}
      {cta ? (
        <a className="sf-card-cta" href={href} onClick={(event) => followInApp(event, href, onNavigate)}>
          {cta}
        </a>
      ) : null}
    </article>
  );
}
