import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { createTask, DEFAULT_SETTINGS, isMainRef, markReady, type Task } from "@factory/core";
import { useTopBarLead } from "../../app/topBarLead";
import { boardStore } from "../../lib/board";
import { clearUnsent, keepUnsent, useUnsent } from "../../lib/unsent";
import { taskPath } from "../board/status";
import { followInApp } from "../board/TaskCard";
import { useBoard } from "../board/useBoard";
import { useFactories, useSelectedFactory, type FactoryEntry } from "../factories/useFactories";
import { useSettings } from "../settings/useSettings";
import { DependsOnPicker } from "../task/DependsOnPicker";
import { BackToBoard } from "../task/TaskView";
import { describeWriteError, NEVER_MAIN_BASE, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { setReadyProblem } from "./createdNotice";

type Navigate = (path: string) => void;

const NEW_TASK_FIELDS = ["title", "description", "factory", "repo", "baseBranch"] as const;
const newTaskId = (field: (typeof NEW_TASK_FIELDS)[number]) => `new-task:${field}`;

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;
const NOTE_MAX = 40;
const FALLBACK_BASE = "dev";
const NO_TASKS: readonly Task[] = [];
/** The parameters of a New task link; dropped from the address bar once read. */
const LINK_PARAMS = ["new", "title", "description", "factory", "repo", "base"];

const STEPS = [
  "The spec writer turns this into a spec with acceptance criteria.",
  "You approve the spec (or ask for changes).",
  "The factory plans, builds test-first, checks, verifies and reviews.",
  "It opens a PR into the base branch. You merge it on GitHub."
];

const GATE_LABELS = [["spec", "Spec"], ["plan", "Plan"], ["pr", "PR"]] as const;

/** The link's factory and repo, checked once the factories are known (see `applyLink`). */
type LinkChoice = { factory: string; repo: string; base: string };
type LinkPrefill = { open: boolean; choice: LinkChoice | undefined };

/** Keeps a field's unsent text, or forgets it when it equals the field's starting value. */
function hold(field: (typeof NEW_TASK_FIELDS)[number], text: string, initial: string) {
  if (text === initial) clearUnsent(newTaskId(field));
  else keepUnsent(newTaskId(field), text);
}

/**
 * `/tasks/new?new=1&title=…&description=…&factory=…&repo=…&base=…` (made by /factory:new, forwarded from `/?new=1…`
 * by the Board) fills the form in. The values replace any unsent draft text and are written where the form reads its
 * starting text, and nothing is submitted: the owner reads the form and clicks Create task. The factory, repo and
 * base need the factories, so they are settled when the form first renders them. Safe to call twice (StrictMode).
 */
function readLinkPrefill(): LinkPrefill {
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") !== "1") return { choice: undefined, open: false };
  hold("title", (params.get("title") ?? "").slice(0, TITLE_MAX), "");
  hold("description", (params.get("description") ?? "").slice(0, DESCRIPTION_MAX), "");
  return {
    choice: { base: params.get("base")?.trim() ?? "", factory: params.get("factory")?.trim() ?? "", repo: params.get("repo")?.trim() ?? "" },
    open: true
  };
}

const quote = (value: string) => value.slice(0, NOTE_MAX);

/** The factory a new task starts in: the picked one, else the first. */
function startFactory(entries: readonly FactoryEntry[], picked: string): FactoryEntry | undefined {
  return entries.find((entry) => entry.def.factoryId === picked) ?? entries[0];
}

/**
 * Writes the link's factory, repo and base where the form reads them, and returns the note for a factory or repo
 * the link names that does not exist. An unknown factory falls back to the picked (or first) factory and its first
 * repo; an unknown repo to the factory's first repo. The base is the link's, else the repo's own.
 */
function applyLink(choice: LinkChoice, entries: readonly FactoryEntry[], picked: string): string {
  const fallback = startFactory(entries, picked);
  const named = choice.factory ? entries.find((entry) => entry.def.factoryId === choice.factory) : undefined;
  const unknownFactory = Boolean(choice.factory) && !named;
  const entry = named ?? fallback;
  const firstRepo = entry?.repos[0];
  const repo = !unknownFactory ? entry?.repos.find((r) => r.repoId === choice.repo) : undefined;
  const unknownRepo = !unknownFactory && Boolean(choice.repo) && !repo;
  const chosen = repo ?? firstRepo;
  hold("factory", entry?.def.factoryId ?? "", fallback?.def.factoryId ?? "");
  hold("repo", chosen?.repoId ?? "", firstRepo?.repoId ?? "");
  const defaultBase = chosen?.baseBranch ?? FALLBACK_BASE;
  hold("baseBranch", choice.base || defaultBase, defaultBase);
  if (unknownFactory) return `Unknown factory "${quote(choice.factory)}" in the link; pick one.`;
  return unknownRepo ? `Unknown repo "${quote(choice.repo)}" in the link; pick one.` : "";
}

/**
 * New task, its own page at /tasks/new: the form on the left and "What happens next" on the right. Creating a task
 * goes to the task's page; Cancel goes back to the Board and keeps the unsent draft.
 */
export function NewTaskPage({ onNavigate }: { onNavigate: Navigate }) {
  const factories = useFactories();
  const board = useBoard();
  const [picked] = useSelectedFactory();
  const formId = useId();
  // A New task link wins over unsent text; read once.
  const [prefill] = useState(readLinkPrefill);
  const [link, setLink] = useState(prefill.choice);
  // The factory picked in the form, for the gates line; unset until the form is shown.
  const [factoryId, setFactoryId] = useState<string>();
  // Drop the link's parameters so a reload does not fill the form again.
  useEffect(() => {
    if (!prefill.open) return;
    const params = new URLSearchParams(window.location.search);
    for (const key of LINK_PARAMS) params.delete(key);
    const rest = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    // replaceState fires no event: tell the router, so a later sign-in redirect does not carry the link again.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [prefill]);

  const entries = [...factories.byId.values()];
  const failed = Boolean(factories.error) && factories.loading === false && factories.byId.size === 0;

  return (
    <div className="sf-view sf-new-task">
      <nav aria-label="Breadcrumb" className="sf-breadcrumb">
        <BackToBoard label="Board" onNavigate={onNavigate} />
        <span> / New task</span>
      </nav>
      <h1 className="sf-page-title">New task</h1>
      <div className="sf-new-task-body">
        <div className="sf-new-task-main">
          <NewTaskPanel
            id={formId}
            entries={entries}
            factoriesLoading={factories.loading}
            factoriesFailed={failed}
            link={link}
            picked={picked}
            tasks={board.data ?? NO_TASKS}
            onLinkUsed={() => setLink(undefined)}
            onCancel={() => onNavigate("/")}
            onFactory={setFactoryId}
            onCreated={(task, problem) => {
              if (problem) setReadyProblem(task.taskId, problem);
              onNavigate(taskPath(task.taskId));
            }}
          />
        </div>
        <WhatHappensNext factoryId={factoryId} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

/** The four steps after Create task, and the gates the selected factory has on. */
function WhatHappensNext({ factoryId, onNavigate }: { factoryId: string | undefined; onNavigate: Navigate }) {
  const headingId = useId();
  const settings = useSettings();
  let gates: string | undefined;
  if (settings.data && factoryId) {
    const on = settings.data.factories[factoryId]?.factory.gates ?? DEFAULT_SETTINGS.gates;
    gates = GATE_LABELS.filter(([key]) => on[key]).map(([, label]) => label).join(", ") || "none";
  }
  return (
    <aside className="sf-panel sf-new-task-aside" aria-labelledby={headingId}>
      <h2 id={headingId}>What happens next</h2>
      <ol>
        {STEPS.map((step) => <li key={step}>{step}</li>)}
      </ol>
      {gates !== undefined ? (
        <p className="sf-hint">
          Gates you have on: {gates}. Change them in{" "}
          <a href="/settings" onClick={(event) => followInApp(event, "/settings", onNavigate)}>Settings</a>.
        </p>
      ) : null}
    </aside>
  );
}

type PanelProps = {
  entries: FactoryEntry[];
  factoriesFailed: boolean;
  factoriesLoading: boolean;
  id: string;
  link: LinkChoice | undefined;
  onCancel: () => void;
  onCreated: (task: Task, readyProblem?: WriteProblem) => void;
  onFactory: (factoryId: string) => void;
  onLinkUsed: () => void;
  picked: string;
  tasks: readonly Task[];
};

/** Waits for the factories, then settles the link's choices once and mounts the form. */
function NewTaskPanel({ entries, factoriesFailed, factoriesLoading, link, onLinkUsed, picked, ...rest }: PanelProps) {
  const ready = !factoriesLoading && entries.length > 0;
  // The note is state of its own: it clears on a factory or repo change.
  const [note, setNote] = useState("");
  const [applied, setApplied] = useState(false);
  // Settles the link once, in an effect: applyLink writes the unsent text, which a render must not do. The form mounts after it.
  useEffect(() => {
    if (!ready || applied) return;
    if (link) setNote(applyLink(link, entries, picked));
    setApplied(true);
  }, [applied, entries, link, picked, ready]);
  useEffect(() => {
    if (applied && link) onLinkUsed();
  }, [applied, link, onLinkUsed]);

  if (factoriesLoading) return <p className="sf-empty" role="status">Loading factories…</p>;
  if (factoriesFailed) return <p className="sf-problem" role="alert">Could not load the factories.</p>;
  if (entries.length === 0) return <p className="sf-empty" role="status">No factory is set up yet.</p>;
  if (!applied) return null;
  return <NewTaskForm {...rest} entries={entries} start={startFactory(entries, picked)!.def.factoryId} note={note} onNoteClear={() => setNote("")} />;
}

type FormProps = Pick<PanelProps, "entries" | "id" | "onCancel" | "onCreated" | "onFactory" | "tasks"> & { note: string; onNoteClear: () => void; start: string };

function NewTaskForm({ entries, id, note, onCancel, onCreated, onFactory, onNoteClear, start, tasks }: FormProps) {
  // Phones: Cancel sits at the left of the top bar; it goes back to the Board like the Cancel button.
  useTopBarLead({ label: "Cancel", onClick: onCancel });
  const [title, setTitle, clearTitle] = useUnsent(newTaskId("title"));
  const [description, setDescription, clearDescription] = useUnsent(newTaskId("description"));
  const [factoryValue, setFactory, clearFactory] = useUnsent(newTaskId("factory"), start);
  const entry: FactoryEntry = entries.find((e) => e.def.factoryId === factoryValue) ?? entries.find((e) => e.def.factoryId === start) ?? entries[0]!;
  const repos = entry.repos;
  const [repoValue, setRepo, clearRepo] = useUnsent(newTaskId("repo"), repos[0]?.repoId ?? "");
  const repo = repos.find((r) => r.repoId === repoValue) ?? repos[0];
  const [baseBranch, setBaseBranch, clearBase] = useUnsent(newTaskId("baseBranch"), repo?.baseBranch ?? FALLBACK_BASE);
  const [problem, setProblem] = useState<WriteProblem>();
  const [baseProblem, setBaseProblem] = useState("");
  const [busy, setBusy] = useState(false);
  // Plain state, not unsent text: a refresh drops it.
  const [readyNow, setReadyNow] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const invalidate = useInvalidateAfterWrite();
  const factoryId = entry.def.factoryId;
  useEffect(() => onFactory(factoryId), [factoryId, onFactory]);

  /** The base follows the repo's own base branch until the owner types another. */
  function pick(nextFactory: string, repoId: string) {
    const next = entries.find((e) => e.def.factoryId === nextFactory)?.repos.find((r) => r.repoId === repoId);
    if (next && baseBranch === repo?.baseBranch) setBaseBranch(next.baseBranch);
    if (nextFactory !== entry.def.factoryId) setDependsOn([]);
    setFactory(nextFactory);
    setRepo(repoId);
    onNoteClear();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !repo) return;
    setProblem(undefined);
    // A blank base branch is the repo's own base branch.
    const base = baseBranch.trim() || repo.baseBranch;
    if (isMainRef(base)) {
      setBaseProblem(NEVER_MAIN_BASE);
      return;
    }
    setBaseProblem("");
    setBusy(true);
    try {
      let task = await createTask(boardStore, now, { baseBranch: base, dependsOn, description, factoryId: entry.def.factoryId, repo: repo.repoId, title });
      // The task exists now. If it cannot be marked ready it stays in the inbox, and its page says so.
      let readyProblem: WriteProblem | undefined;
      if (readyNow) {
        try {
          task = await markReady(boardStore, now, task.taskId);
        } catch (error) {
          readyProblem = describeWriteError(error);
        }
      }
      clearTitle();
      clearDescription();
      clearFactory();
      clearRepo();
      clearBase();
      setDependsOn([]);
      void invalidate();
      onCreated(task, readyProblem);
    } catch (error) {
      setProblem(describeWriteError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id={id} className="sf-form sf-panel" aria-label="New task" onSubmit={(event) => void submit(event)}>
      <div className="sf-field-row">
        <label className="sf-field" htmlFor={`${id}-factory`}>
          <span>Factory</span>
          <select id={`${id}-factory`} className="sf-select" value={entry.def.factoryId} onChange={(event) => pick(event.target.value, entries.find((e) => e.def.factoryId === event.target.value)?.repos[0]?.repoId ?? "")}>
            {entries.map((e) => <option key={e.def.factoryId} value={e.def.factoryId}>{e.def.name}</option>)}
          </select>
        </label>
        <label className="sf-field" htmlFor={`${id}-repo`}>
          <span>Repo</span>
          <select id={`${id}-repo`} className="sf-select" value={repo?.repoId ?? ""} onChange={(event) => pick(entry.def.factoryId, event.target.value)}>
            {repos.map((r) => <option key={r.repoId} value={r.repoId}>{r.repoId}</option>)}
          </select>
        </label>
      </div>
      <label className="sf-field" htmlFor={`${id}-title`}>
        <span>Title</span>
        <input id={`${id}-title`} className="sf-input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="sf-field">
        <label htmlFor={`${id}-description`}>Description</label>
        <textarea
          id={`${id}-description`}
          className="sf-input"
          rows={6}
          aria-describedby={`${id}-description-hint`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <p id={`${id}-description-hint`} className="sf-hint">
          Plain words are fine. Acceptance criteria help the spec writer; it asks you if something is unclear.
        </p>
      </div>
      <div className="sf-field">
        <label htmlFor={`${id}-base`}>Base branch</label>
        <input
          id={`${id}-base`}
          className="sf-input sf-mono"
          value={baseBranch}
          aria-describedby={`${id}-base-hint`}
          aria-invalid={baseProblem ? true : undefined}
          onChange={(event) => {
            setBaseBranch(event.target.value);
            setBaseProblem("");
          }}
        />
        <p id={`${id}-base-hint`} className="sf-hint">dev or stg. The factory never targets main.</p>
      </div>
      <DependsOnPicker id={`${id}-deps`} label="Waits for" factoryId={entry.def.factoryId} tasks={tasks} value={dependsOn} onChange={setDependsOn} />
      <label className="sf-switch">
        <input type="checkbox" role="switch" checked={readyNow} onChange={(event) => setReadyNow(event.target.checked)} />
        <span>Mark ready now, so the factory starts it at its next sync</span>
      </label>
      {note ? <p role="status">{note}</p> : null}
      {baseProblem ? <p className="sf-problem" role="alert">{baseProblem}</p> : null}
      <WriteProblemNotice problem={problem} />
      <div className="sf-actions sf-action-bar">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Create task</button>
        <button type="button" className="sf-button sf-action-close" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
