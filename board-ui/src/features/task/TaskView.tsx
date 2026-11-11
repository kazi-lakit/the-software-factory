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
  type Task
} from "@factory/core";
import { describeEvent, eventContexts } from "../../lib/describeEvent";
import { formatTime, formatWhenShort } from "../../lib/formatTime";
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
import { EarlierQuestions, QaLog } from "./QaLog";
import { buildQaLog } from "./qaEntries";
import { Stepper } from "./Stepper";
import { TaskActions } from "./TaskActions";
import { RunsTable } from "./RunsTable";
import { attemptsLabel, costLabel } from "./taskDetails";
import { TaskHistory } from "./TaskHistory";
import { TaskTabs } from "./TaskTabs";
import { currentOf, useTask } from "./useTask";
import { WriteProblemNotice } from "./writeOutcome";

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

const gateOf = (task: Task): Gate | undefined =>
  (Object.entries(GATE_STATUS) as [Gate, Task["status"]][]).find(([, status]) => status === task.status)?.[0];

const HOW_QUESTIONS_WORK =
  "An agent that can't go on asks one question, offers 2 to 4 answers and marks the one it recommends, with a reason. Pick one or write your own. Every question and answer stays on the task and in History.";

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
 * then a tab strip: History, Spec, Plan, Checks, Review, Runs) and a side column (details, description, how questions work).
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
  const blocked = task.status === "blocked";
  const earlier = qaEntries.filter((entry) => !entry.open);

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
        <div className={blocked ? "sf-task-main sf-task-answering" : "sf-task-main"}>
          <TaskMore events={events} task={task} onNavigate={onNavigate} />
          {gate ? (
            <GatePanel key={`${task.taskId}:${gate}`} task={task} gate={gate} docs={docs[GATE_DOC[gate]]} approvals={approvals} onReload={reload} />
          ) : null}
          {blocked ? <AnswerPanel key={task.taskId} task={task} events={events} onReload={reload} /> : null}
          {blocked && earlier.length > 0 ? <EarlierQuestions entries={earlier} /> : null}
          {qaEntries.length > 0 ? <QaLog entries={qaEntries} /> : null}
          <TaskTabs
            key={task.taskId}
            label="Task sections"
            tabs={[
              { content: <TaskHistory events={events} />, id: "history", label: "History" },
              { content: <DocVersions label="Spec" docs={docs.spec} />, id: "spec", label: `Spec (${docs.spec.length})` },
              { content: <DocVersions label="Plan" docs={docs.plan} />, id: "plan", label: `Plan (${docs.plan.length})` },
              { content: <DocVersions label="Checks" docs={docs.verify} />, id: "checks", label: "Checks" },
              { content: <DocVersions label="Review" docs={docs.review} />, id: "review", label: "Review" },
              { content: <RunsTable runs={runs} />, id: "runs", label: `Runs (${runs.length})` }
            ]}
          />
        </div>
        <aside className="sf-task-side" aria-label="Task side panels">
          <Details task={task} onNavigate={onNavigate} />
          <Section title="Description" className="sf-panel">
            {task.description.trim() ? <pre className="sf-doc-body">{task.description}</pre> : <p className="sf-empty">No description.</p>}
          </Section>
          {qaEntries.length > 0 ? (
            <Section title="How questions work" className="sf-panel">
              <p className="sf-muted sf-qa-how">{HOW_QUESTIONS_WORK}</p>
            </Section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/** The cost limit the engine uses: the factory's settings with the repo's override. Unknown until the settings load. */
function useCostLimit(task: Task): number | undefined {
  const stored = useSettings().data;
  const entry = stored?.factories[task.factoryId];
  return stored ? resolveSettings(entry?.factory ?? DEFAULT_SETTINGS, entry?.repos[task.repo]).maxCostPerTaskUsd : undefined;
}

function PrLink({ url }: { url: string }) {
  return (
    <a className="sf-mono" href={url} target="_blank" rel="noopener noreferrer">
      {url.slice(GITHUB.length)}
      <span className="sf-visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/** The tasks this one waits for, each with its status, and a badge naming the unfinished ones while the task is ready. */
function WaitsFor({ onNavigate, task }: { onNavigate: (path: string) => void; task: Task }) {
  const board = useBoard().data ?? [];
  const waiting = task.status === "ready" ? unfinishedDeps(task, board) : [];
  return (
    <>
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
    </>
  );
}

/**
 * Phones: Branch, Cost, PR, Waits for and the last event in a closed disclosure at the top of the main column
 * (the base CSS hides it; the Details panel shows them at 640px and up).
 */
function TaskMore({ events, onNavigate, task }: { events: readonly FactoryEvent[]; onNavigate: (path: string) => void; task: Task }) {
  const limit = useCostLimit(task);
  const prUrl = githubUrl(task.prUrl);
  const newest = events[events.length - 1];
  return (
    <details className="sf-task-more">
      <summary className="sf-label">Details and history</summary>
      <dl>
        <div><dt>Branch</dt><dd className="sf-mono">{task.branch ?? "—"}</dd></div>
        <div><dt>Cost</dt><dd className="sf-mono">{costLabel(task.costUsd, limit)}</dd></div>
        {prUrl ? <div><dt>PR</dt><dd><PrLink url={prUrl} /></dd></div> : null}
        {task.dependsOn.length > 0 ? <div><dt>Waits for</dt><dd><WaitsFor task={task} onNavigate={onNavigate} /></dd></div> : null}
        <div>
          <dt>Last event</dt>
          <dd>
            {newest ? (
              <>
                {describeEvent(newest, eventContexts([...events].reverse()).get(newest)).text}{" "}
                <time className="sf-muted" dateTime={newest.at} title={formatTime(newest.at)}>{formatWhenShort(newest.at)}</time>
              </>
            ) : "No history yet."}
          </dd>
        </div>
      </dl>
    </details>
  );
}

function Details({ onNavigate, task }: { onNavigate: (path: string) => void; task: Task }) {
  const prUrl = githubUrl(task.prUrl);
  // The factory's name when it is visible, else its id.
  const factoryName = useFactories().byId.get(task.factoryId)?.def.name ?? task.factoryId;
  const limit = useCostLimit(task);
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
            {prUrl ? <PrLink url={prUrl} /> : "Not yet"}
          </dd>
        </div>
        {task.dependsOn.length > 0 ? (
          <div>
            <dt>Waits for</dt>
            <dd>
              <WaitsFor task={task} onNavigate={onNavigate} />
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
        <li className="sf-chip sf-chip-repo">{`${task.repo} → ${task.baseBranch}`}</li>
      </ul>
      <div className="sf-task-title-row">
        <h1 ref={heading} tabIndex={-1} className="sf-page-title">{task.title}</h1>
        <TaskActions key={task.taskId} task={task} onReload={onReload} onCancelled={() => heading.current?.focus()} />
      </div>
      <p className="sf-task-repo sf-mono">{`${task.repo} → ${task.baseBranch}`}</p>
      <Stepper status={task.status} stage={task.stage} baseBranch={task.baseBranch} waitingVersion={waitingVersion} />
    </section>
  );
}
