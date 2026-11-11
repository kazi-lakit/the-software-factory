import { useCallback, useId, useRef } from "react";
import type { ReactNode } from "react";
import { GATE_DOC, GATE_STATUS, NotFoundError, unfinishedDeps, type FactoryEvent, type Gate, type Run, type Task } from "@factory/core";
import { ageOf, formatCost, NEEDS_YOU, STATUS_LABEL, taskPath } from "../board/status";
import { useTopBarLead } from "../../app/topBarLead";
import { followInApp } from "../board/TaskCard";
import { useBoard } from "../board/useBoard";
import { useFactories } from "../factories/useFactories";
import { AnswerPanel } from "./AnswerPanel";
import { DocVersions } from "./DocVersions";
import { GatePanel } from "./GatePanel";
import { QaLog } from "./QaLog";
import { buildQaLog } from "./qaEntries";
import { Stepper } from "./Stepper";
import { TaskActions } from "./TaskActions";
import { useTask } from "./useTask";

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

function Section({ children, title }: { children: ReactNode; title: string }) {
  const id = useId();
  return (
    <section className="sf-task-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

function BackToBoard({ label, onNavigate }: { label: string; onNavigate: (path: string) => void }) {
  return <a href="/" className="sf-back" onClick={(event) => followInApp(event, "/", onNavigate)}>{label}</a>;
}

/** One task: its header, description, docs, the gate or answer panel when it waits for you, runs and history. */
export function TaskView({ onNavigate, taskId }: { onNavigate: (path: string) => void; taskId: string }) {
  const query = useTask(taskId);
  const { refetch } = query;
  // Phones: Back sits at the left of the top bar in every state (the in-page link is hidden there).
  useTopBarLead({ label: "Back", onClick: () => onNavigate("/") });
  // Reload after a conflict: resolves with the latest task so open forms can rebase on its version.
  const reload = useCallback(async () => (await refetch()).data?.task, [refetch]);

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
      </nav>
      {query.isError ? <p className="sf-problem" role="alert">Could not refresh this task; showing what was loaded last.</p> : null}
      <TaskHeader task={task} events={events} onReload={reload} />

      <Section title="Description">
        {task.description.trim() ? <pre className="sf-doc-body">{task.description}</pre> : <p className="sf-empty">No description.</p>}
      </Section>
      <div className="sf-task-body">
        <div className="sf-task-docs">
          <Section title="Spec"><DocVersions label="Spec" docs={docs.spec} /></Section>
          <Section title="Plan"><DocVersions label="Plan" docs={docs.plan} /></Section>
        </div>
        <Details task={task} events={events} onNavigate={onNavigate} />
      </div>
      <Section title="Verify report"><DocVersions label="Verify report" docs={docs.verify} /></Section>
      <Section title="Review report"><DocVersions label="Review report" docs={docs.review} /></Section>

      {gate ? (
        <GatePanel key={`${task.taskId}:${gate}`} task={task} gate={gate} docs={docs[GATE_DOC[gate]]} approvals={approvals} onReload={reload} />
      ) : null}
      {task.status === "blocked" ? <AnswerPanel key={task.taskId} task={task} events={events} onReload={reload} /> : null}
      {qaEntries.length > 0 ? <Section title="Questions and answers"><QaLog entries={qaEntries} /></Section> : null}

      <Section title="Runs"><RunsTable runs={runs} /></Section>
      <Section title="History"><History events={events} /></Section>
    </div>
  );
}

function Details({ events, onNavigate, task }: { events: readonly FactoryEvent[]; onNavigate: (path: string) => void; task: Task }) {
  const last = events.at(-1);
  const board = useBoard().data ?? [];
  const waiting = task.status === "ready" ? unfinishedDeps(task, board) : [];
  return (
    <aside className="sf-details" aria-label="Details">
      <dl>
        <div><dt>Branch</dt><dd className="sf-mono">{task.branch ?? "—"}</dd></div>
        {task.dependsOn.length > 0 ? (
          <div>
            <dt>Depends on</dt>
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
        <div><dt>Cost</dt><dd className="sf-mono">{formatCost(task.costUsd)}</dd></div>
        <div>
          <dt>Last event</dt>
          <dd>{last ? `${last.field ?? last.action}: ${short(last.to)} · ${formatTime(last.at)}` : "—"}</dd>
        </div>
      </dl>
    </aside>
  );
}

function TaskHeader({ events, onReload, task }: { events: readonly FactoryEvent[]; onReload: () => Promise<Task | undefined>; task: Task }) {
  const age = ageOf(events.find((event) => event.action === "create")?.at);
  const prUrl = githubUrl(task.prUrl);
  // The factory's name when it is visible, else its id.
  const factoryName = useFactories().byId.get(task.factoryId)?.def.name ?? task.factoryId;
  // After a cancel the Cancel button is gone; focus lands on the task's heading instead of the page.
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section className="sf-task-header" aria-label="Task details">
      <h2 ref={heading} tabIndex={-1}>{task.title}</h2>
      <p className="sf-task-meta">
        <span>{task.repo}</span>
        <span aria-hidden="true">·</span>
        <span className="sf-mono">{task.baseBranch}</span>
        {age ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{age}</span>
          </>
        ) : null}
      </p>
      <Stepper status={task.status} stage={task.stage} baseBranch={task.baseBranch} />
      <dl className="sf-facts">
        <div><dt>Task</dt><dd className="sf-mono">{task.taskId}</dd></div>
        <div><dt>Factory</dt><dd>{factoryName}</dd></div>
        <div>
          <dt>PR</dt>
          <dd>
            {prUrl ? (
              <a className="sf-mono" href={prUrl} target="_blank" rel="noopener noreferrer">
                {prUrl.slice(GITHUB.length)}
                <span className="sf-visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : "—"}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span>{STATUS_LABEL[task.status]}</span>
            {NEEDS_YOU.has(task.status) ? <span className="sf-badge">Waiting for you</span> : null}
          </dd>
        </div>
        <div><dt>Stage</dt><dd>{task.stage ?? "—"}</dd></div>
        <div><dt>Attempt</dt><dd className="sf-mono">{task.attempt}</dd></div>
      </dl>
      <TaskActions key={task.taskId} task={task} onReload={onReload} onCancelled={() => heading.current?.focus()} />
    </section>
  );
}

function RunsTable({ runs }: { runs: readonly Run[] }) {
  if (runs.length === 0) return <p className="sf-empty">No runs yet.</p>;
  return (
    <div className="sf-table-wrap">
      <table className="sf-table" aria-label="Runs">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Agent</th>
            <th scope="col">Mode</th>
            <th scope="col">Started</th>
            <th scope="col">Ended</th>
            <th scope="col">Turns</th>
            <th scope="col">Cost</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId}>
              <td>{run.step}</td>
              <td>{run.agent}</td>
              <td>{run.mode}</td>
              <td><time dateTime={run.startedAt}>{formatTime(run.startedAt)}</time></td>
              <td>{run.endedAt ? <time dateTime={run.endedAt}>{formatTime(run.endedAt)}</time> : "running"}</td>
              <td className="sf-mono">{run.turns ?? "—"}</td>
              <td className="sf-mono">{formatCost(run.costUsd)}</td>
              <td>{run.result ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
