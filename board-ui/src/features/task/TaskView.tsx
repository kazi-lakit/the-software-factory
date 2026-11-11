import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_SETTINGS,
  GATE_DOC,
  GATE_STATUS,
  NotFoundError,
  resolveSettings,
  unfinishedDeps,
  type Doc,
  type DocKind,
  type FactoryEvent,
  type Gate,
  type Run,
  type Task
} from "@factory/core";
import { NEEDS_YOU, STATUS_LABEL, taskPath } from "../board/status";
import { useTopBarLead } from "../../app/topBarLead";
import { followInApp } from "../board/TaskCard";
import { useBoard } from "../board/useBoard";
import { useFactories } from "../factories/useFactories";
import { clearReadyProblem, peekReadyProblem } from "../newTask/createdNotice";
import { useSettings } from "../settings/useSettings";
import { AnswerPanel } from "./AnswerPanel";
import { DocVersions } from "./DocVersions";
import { GatePanel } from "./GatePanel";
import { QaLog } from "./QaLog";
import { buildQaLog } from "./qaEntries";
import { Stepper } from "./Stepper";
import { TaskActions } from "./TaskActions";
import { attemptsLabel, costLabel, runLines } from "./taskDetails";
import { currentOf, useTask } from "./useTask";
import { WriteProblemNotice } from "./writeOutcome";

const DOC_SECTIONS = [["spec", "Spec"], ["plan", "Plan"], ["verify", "Verify report"], ["review", "Review report"]] as const;

const GITHUB = "https://github.com/";

/** A PR link only to github.com over https; anything else (another host, http, a script URL) is not linked. */
function githubUrl(value: string | null): string | undefined {
  if (!value?.startsWith(GITHUB)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? value : undefined;
  } catch {
    return undefined;
  }
}

const formatTime = (iso: string | null): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

const gateOf = (task: Task): Gate | undefined =>
  (Object.entries(GATE_STATUS) as [Gate, Task["status"]][]).find(([, status]) => status === task.status)?.[0];

const short = (value: string | null): string => {
  if (value === null) return "—";
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

function Section({ children, className = "sf-task-section", title }: { children: ReactNode; className?: string; title: string }) {
  const id = useId();
  return (
    <section className={className} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** The in-page link back to the Board, shared by the task and New task breadcrumbs. */
export function BackToBoard({ label, onNavigate }: { label: string; onNavigate: (path: string) => void }) {
  return <a href="/" className="sf-back" onClick={(event) => followInApp(event, "/", onNavigate)}>{label}</a>;
}

/**
 * One task: the header, then a main column (the gate or answer panel when it waits for you, questions and answers,
 * docs, history) and a side column (details, description, runs).
 */
export function TaskView({ onNavigate, taskId }: { onNavigate: (path: string) => void; taskId: string }) {
  const query = useTask(taskId);
  const { refetch } = query;
  // Phones: Back sits at the left of the top bar in every state (the in-page link is hidden there).
  useTopBarLead({ label: "Back", onClick: () => onNavigate("/") });
  // Reload after a conflict: resolves with the latest task so open forms can rebase on its version.
  const reload = useCallback(async () => (await refetch()).data?.task, [refetch]);
  // Set by New task when this task was created but not marked ready: shown once, then forgotten.
  const [readyProblem] = useState(() => peekReadyProblem(taskId));
  useEffect(() => clearReadyProblem(taskId), [taskId]);

  if (!query.data) {
    if (query.isError) {
      if (query.error instanceof NotFoundError) {
        return (
          <div className="sf-view">
            <p>Task <span className="sf-mono">{taskId}</span> was not found.</p>
            <BackToBoard label="Back to the Board" onNavigate={onNavigate} />
          </div>
        );
      }
      return (
        <div className="sf-view" role="alert">
          <p>Could not load <span className="sf-mono">{taskId}</span>.</p>
          <button type="button" className="sf-button" onClick={() => void refetch()}>Try again</button>
        </div>
      );
    }
    return <p className="sf-empty" role="status">Loading {taskId}…</p>;
  }

  const { approvals, docs, events, runs, task } = query.data;
  const gate = gateOf(task);
  const qaEntries = buildQaLog(events, task.status === "blocked" ? task.question : null);

  return (
    <div className="sf-view sf-task">
      <nav aria-label="Breadcrumb" className="sf-breadcrumb">
        <BackToBoard label="Board" onNavigate={onNavigate} />
        <span aria-hidden="true">/</span>
        <span className="sf-mono" aria-current="page">{task.taskId}</span>
      </nav>
      {readyProblem ? (
        <>
          <WriteProblemNotice problem={readyProblem} />
          <p className="sf-problem" role="alert">The task was created but not marked ready.</p>
        </>
      ) : null}
      {query.isError ? <p className="sf-problem" role="alert">Could not refresh this task; showing what was loaded last.</p> : null}
      <TaskHeader task={task} gate={gate} docs={docs} onReload={reload} />

      <div className="sf-task-body">
        <div className="sf-task-main">
          {gate ? (
            <GatePanel key={`${task.taskId}:${gate}`} task={task} gate={gate} docs={docs[GATE_DOC[gate]]} approvals={approvals} onReload={reload} />
          ) : null}
          {task.status === "blocked" ? <AnswerPanel key={task.taskId} task={task} events={events} onReload={reload} /> : null}
          {qaEntries.length > 0 ? <Section title="Questions and answers"><QaLog entries={qaEntries} /></Section> : null}
          {/* The decision panel shows the gate's doc, so its section is left out here. */}
          {DOC_SECTIONS.filter(([kind]) => !gate || GATE_DOC[gate] !== kind).map(([kind, title]) => (
            <Section key={kind} title={title}><DocVersions label={title} docs={docs[kind]} /></Section>
          ))}
          <Section title="History"><History events={events} /></Section>
        </div>
        <aside className="sf-task-side" aria-label="Task side panels">
          <Details task={task} onNavigate={onNavigate} />
          <Section title="Description" className="sf-panel">
            {task.description.trim() ? <pre className="sf-doc-body">{task.description}</pre> : <p className="sf-empty">No description.</p>}
          </Section>
          <Section title="Runs" className="sf-panel"><RunsList runs={runs} /></Section>
        </aside>
      </div>
    </div>
  );
}

function Details({ onNavigate, task }: { onNavigate: (path: string) => void; task: Task }) {
  const board = useBoard().data ?? [];
  const waiting = task.status === "ready" ? unfinishedDeps(task, board) : [];
  const prUrl = githubUrl(task.prUrl);
  // The factory's name when it is visible, else its id.
  const factoryName = useFactories().byId.get(task.factoryId)?.def.name ?? task.factoryId;
  // The cost limit the engine uses: the factory's settings with the repo's override. Unknown until the settings load.
  const stored = useSettings().data;
  const entry = stored?.factories[task.factoryId];
  const limit = stored ? resolveSettings(entry?.factory ?? DEFAULT_SETTINGS, entry?.repos[task.repo]).maxCostPerTaskUsd : undefined;
  const headingId = useId();
  return (
    <section className="sf-details" aria-labelledby={headingId}>
      <h3 id={headingId}>Details</h3>
      <dl>
        <div><dt>Repo</dt><dd>{task.repo}</dd></div>
        <div><dt>Base</dt><dd className="sf-mono">{task.baseBranch}</dd></div>
        <div><dt>Branch</dt><dd className="sf-mono">{task.branch ?? "—"}</dd></div>
        <div><dt>Factory</dt><dd>{factoryName}</dd></div>
        <div>
          <dt>PR</dt>
          <dd>
            {prUrl ? (
              <a className="sf-mono" href={prUrl} target="_blank" rel="noopener noreferrer">
                {prUrl.slice(GITHUB.length)}
                <span className="sf-visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : "Not yet"}
          </dd>
        </div>
        {task.dependsOn.length > 0 ? (
          <div>
            <dt>Waits for</dt>
            <dd>
              <ul className="sf-deps">
                {task.dependsOn.map((id) => {
                  const dep = board.find((t) => t.taskId === id);
                  const href = taskPath(id);
                  return (
                    <li key={id}>
                      <a className="sf-mono" href={href} onClick={(event) => followInApp(event, href, onNavigate)}>{id}</a>
                      {dep ? <span> {STATUS_LABEL[dep.status]}</span> : null}
                    </li>
                  );
                })}
              </ul>
              {waiting.length > 0 ? <span className="sf-badge">Waiting on {waiting.join(", ")}</span> : null}
            </dd>
          </div>
        ) : null}
        {/* core's browser entry does not export MAX_RETURNS, so no limit is shown. */}
        <div><dt>Attempts</dt><dd>{attemptsLabel(task.attempt)}</dd></div>
        <div><dt>Cost</dt><dd className="sf-mono">{costLabel(task.costUsd, limit)}</dd></div>
      </dl>
    </section>
  );
}

function TaskHeader({ docs, gate, onReload, task }: {
  docs: Record<DocKind, Doc[]>;
  gate: Gate | undefined;
  onReload: () => Promise<Task | undefined>;
  task: Task;
}) {
  const waitsForYou = NEEDS_YOU.has(task.status);
  // The version of the doc the owner decides on, for the stepper's "Spec · vN waiting".
  const waitingVersion = gate === "spec" || gate === "plan" ? currentOf(docs[GATE_DOC[gate]])?.version : undefined;
  // After a cancel the Cancel button is gone; focus lands on the task's heading instead of the page.
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section className="sf-task-header" aria-label="Task details">
      <ul className="sf-chips sf-task-chips" aria-label="Task summary">
        <li className="sf-chip sf-mono">{task.taskId}</li>
        <li className={waitsForYou ? "sf-chip sf-chip-waiting" : "sf-chip"}>
          {waitsForYou ? `${STATUS_LABEL[task.status]} · waiting for you` : STATUS_LABEL[task.status]}
        </li>
        <li className="sf-chip">{`${task.repo} → ${task.baseBranch}`}</li>
      </ul>
      <div className="sf-task-title-row">
        <h1 ref={heading} tabIndex={-1} className="sf-page-title">{task.title}</h1>
        <TaskActions key={task.taskId} task={task} onReload={onReload} onCancelled={() => heading.current?.focus()} />
      </div>
      <Stepper status={task.status} stage={task.stage} baseBranch={task.baseBranch} waitingVersion={waitingVersion} />
    </section>
  );
}

function RunsList({ runs }: { runs: readonly Run[] }) {
  if (runs.length === 0) return <p className="sf-empty">No runs yet.</p>;
  return (
    <ul className="sf-runs" aria-label="Runs">
      {runLines(runs).map((line) => <li key={line.runId}>{line.text}</li>)}
    </ul>
  );
}

function describeEvent(event: FactoryEvent): string {
  if (event.action === "create") return `created in ${event.to ?? "inbox"}`;
  return `${event.field ?? event.action}: ${short(event.from)} → ${short(event.to)}`;
}

function History({ events }: { events: readonly FactoryEvent[] }) {
  if (events.length === 0) return <p className="sf-empty">No history yet.</p>;
  const newestFirst = [...events].reverse();
  return (
    <ol className="sf-history" aria-label="History">
      {newestFirst.map((event, index) => (
        <li key={`${event.at}-${index}`}>
          <time className="sf-muted" dateTime={event.at}>{formatTime(event.at)}</time>
          <span className="sf-history-actor">{event.actor}</span>
          <span>{describeEvent(event)}</span>
          {event.reason ? <span className="sf-muted">({event.reason})</span> : null}
        </li>
      ))}
    </ol>
  );
}
