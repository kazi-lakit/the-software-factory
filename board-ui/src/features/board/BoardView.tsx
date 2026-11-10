import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createTask, isMainRef, type FactoryRepo, type Status, type Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { clearUnsent, hasUnsent, keepUnsent, useUnsent } from "../../lib/unsent";
import { useFactories, useSelectedFactory, type FactoryEntry } from "../factories/useFactories";
import { describeWriteError, NEVER_MAIN_BASE, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { FactoryPicker } from "./FactoryPicker";
import { COLUMNS, isTestTask, MUTED, STATUS_LABEL } from "./status";
import { TaskCard } from "./TaskCard";
import { useBoard } from "./useBoard";
import { WaitingStrip } from "./WaitingStrip";

type Navigate = (path: string) => void;

const NEW_TASK_FIELDS = ["title", "description", "factory", "repo", "baseBranch"] as const;
const newTaskId = (field: (typeof NEW_TASK_FIELDS)[number]) => `new-task:${field}`;

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;
const NOTE_MAX = 40;
const FALLBACK_BASE = "dev";
const NO_REPOS: readonly FactoryRepo[] = [];

/** The link's factory and repo, checked once the factories are known (see `applyLink`). */
type LinkChoice = { factory: string; repo: string; base: string };
type LinkPrefill = { open: boolean; choice: LinkChoice | undefined };

/**
 * `/?new=1&title=…&description=…&factory=…&repo=…&base=…` (made by /factory:new) opens the New task form filled in.
 * The values replace any unsent draft text and are written where the form reads its starting text, and nothing
 * is submitted: the owner reads the form and clicks Create task. The factory, repo and base need the factories,
 * so they are settled when the form first renders them. Safe to call twice (StrictMode).
 */
function readLinkPrefill(): LinkPrefill {
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") !== "1") return { choice: undefined, open: false };
  const hold = (field: (typeof NEW_TASK_FIELDS)[number], text: string, initial: string) => {
    if (text === initial) clearUnsent(newTaskId(field));
    else keepUnsent(newTaskId(field), text);
  };
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
  const hold = (field: (typeof NEW_TASK_FIELDS)[number], text: string, initial: string) => {
    if (text === initial) clearUnsent(newTaskId(field));
    else keepUnsent(newTaskId(field), text);
  };
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

const repoKey = (repo: FactoryRepo) => `${repo.factoryId}/${repo.repoId}`;

/** The queue: a column per status, factory and repo filters, test tasks hidden by default, and the New task form. */
export function BoardView({ onNavigate }: { onNavigate: Navigate }) {
  const board = useBoard();
  const factories = useFactories();
  const filterId = useId();
  const formId = useId();
  const [picked, setPicked] = useSelectedFactory();
  const [repo, setRepo] = useState("");
  const [showTest, setShowTest] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<Status>>(new Set());
  // A New task link wins over unsent text; otherwise reopens on unsent text, e.g. after the session ended mid-form.
  const [prefill] = useState(readLinkPrefill);
  const [link, setLink] = useState(prefill.choice);
  const [creating, setCreating] = useState(() => prefill.open || NEW_TASK_FIELDS.some((f) => hasUnsent(newTaskId(f))));
  // Drop the link's parameters so a reload does not fill the form again.
  useEffect(() => {
    if (!prefill.open) return;
    const params = new URLSearchParams(window.location.search);
    for (const key of ["new", "title", "description", "factory", "repo", "base"]) params.delete(key);
    const rest = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    // replaceState fires no event: tell the router, so a later sign-in redirect does not carry the link again.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [prefill]);
  const [notice, setNotice] = useState("");
  const newTaskButton = useRef<HTMLButtonElement>(null);
  // After a create the form is gone: focus returns to the button that opened it.
  const [refocusNewTask, setRefocusNewTask] = useState(false);
  useEffect(() => {
    if (!refocusNewTask) return;
    newTaskButton.current?.focus();
    setRefocusNewTask(false);
  }, [refocusNewTask]);

  // A pick that is no longer a visible factory counts as All; tasks of a factory that is not visible show under All.
  const known = factories.byId.has(picked);
  const factory = picked === "all" || (!factories.loading && !known) ? "all" : picked;
  const all = factory === "all";
  const repoOptions: readonly FactoryRepo[] = all ? factories.repos : (factories.byId.get(factory)?.repos ?? NO_REPOS);

  const inFactory = (board.data ?? []).filter((task) => all || task.factoryId === factory);
  const visible = inFactory.filter((task) => (showTest || !isTestTask(task)) && (repo === "" || (all ? `${task.factoryId}/${task.repo}` : task.repo) === repo));
  const waiting = inFactory.filter((task) => showTest || !isTestTask(task));
  const byStatus = new Map<Status, Task[]>(COLUMNS.map((status) => [status, []]));
  for (const task of visible) byStatus.get(task.status)?.push(task);

  function toggle(status: Status) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className="sf-view">
      <div className="sf-toolbar">
        <h2>Board</h2>
        <FactoryPicker
          defs={factories.defs}
          value={factory}
          onChange={(value) => {
            setPicked(value);
            setRepo("");
          }}
        />
        <label className="sf-inline-field" htmlFor={filterId}>
          <span>Repo</span>
          <select id={filterId} className="sf-select" value={repo} onChange={(event) => setRepo(event.target.value)}>
            <option value="">All repos</option>
            {repoOptions.map((r) => {
              const value = all ? repoKey(r) : r.repoId;
              return <option key={value} value={value}>{value}</option>;
            })}
          </select>
        </label>
        <label className="sf-inline-field">
          <input type="checkbox" checked={showTest} onChange={(event) => setShowTest(event.target.checked)} />
          <span>Show test tasks</span>
        </label>
        <button
          ref={newTaskButton}
          type="button"
          className={`sf-button sf-toolbar-end${creating ? "" : " sf-button-primary"}`}
          aria-expanded={creating}
          aria-controls={creating ? formId : undefined}
          onClick={() => {
            // Closing the form drops a link it has not used yet, so a later open does not apply it.
            if (creating) setLink(undefined);
            setCreating(!creating);
          }}
        >
          New task
        </button>
      </div>
      <p className="sf-visually-hidden" role="status">{notice}</p>

      {creating ? (
        <NewTaskPanel
          id={formId}
          entries={[...factories.byId.values()]}
          factoriesLoading={factories.loading}
          factoriesFailed={Boolean(factories.error) && factories.loading === false && factories.byId.size === 0}
          link={link}
          picked={factory}
          onLinkUsed={() => setLink(undefined)}
          onClose={() => {
            setLink(undefined);
            setCreating(false);
          }}
          onCreated={(task) => {
            setLink(undefined);
            setCreating(false);
            setRefocusNewTask(true);
            setNotice(`Created ${task.taskId}.`);
          }}
        />
      ) : null}

      {board.isError ? (
        <div className="sf-problem" role="alert">
          <span>{board.data ? "Could not refresh the Board; showing what was loaded last." : "Could not load the Board."}</span>
          <button type="button" className="sf-button" onClick={() => void board.refetch()}>Try again</button>
        </div>
      ) : null}
      {board.isPending ? <p className="sf-empty" role="status">Loading tasks…</p> : null}

      {board.data ? <WaitingStrip tasks={waiting} showFactory={all} onNavigate={onNavigate} /> : null}

      {board.data ? (
        <div className="sf-columns">
          {COLUMNS.map((status) => {
            const tasks = byStatus.get(status) ?? [];
            const collapsible = MUTED.has(status);
            const open = !collapsible || expanded.has(status);
            const listed = open && tasks.length > 0;
            const listId = `${formId}-${status}`;
            const tone = collapsible ? " sf-column-muted" : "";
            return (
              <section key={status} className={`sf-column${tone}${open ? "" : " sf-column-collapsed"}`} aria-label={STATUS_LABEL[status]}>
                <h3 className="sf-column-head">
                  {collapsible ? (
                    <button type="button" className="sf-column-toggle" aria-expanded={open} aria-controls={listed ? listId : undefined} onClick={() => toggle(status)}>
                      {STATUS_LABEL[status]} ({tasks.length})
                    </button>
                  ) : (
                    <>
                      <span>{STATUS_LABEL[status]}</span>
                      <span className="sf-count sf-mono">{tasks.length}</span>
                    </>
                  )}
                </h3>
                {listed ? (
                  <ul id={listId} className="sf-card-list">
                    {tasks.map((task) => (
                      <li key={task.taskId}><TaskCard task={task} showFactory={all} onNavigate={onNavigate} /></li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type PanelProps = {
  entries: FactoryEntry[];
  factoriesFailed: boolean;
  factoriesLoading: boolean;
  id: string;
  link: LinkChoice | undefined;
  onClose: () => void;
  onCreated: (task: Task) => void;
  onLinkUsed: () => void;
  picked: string;
};

/** Waits for the factories, then settles the link's choices once and mounts the form. */
function NewTaskPanel({ entries, factoriesFailed, factoriesLoading, link, onClose, onLinkUsed, picked, ...rest }: PanelProps) {
  const ready = !factoriesLoading && entries.length > 0;
  // The note is state of its own: it clears on a factory or repo change and on close (the panel unmounts).
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
  return <NewTaskForm {...rest} entries={entries} start={startFactory(entries, picked)!.def.factoryId} note={note} onNoteClear={() => setNote("")} onClose={onClose} />;
}

type FormProps = Pick<PanelProps, "entries" | "id" | "onCreated"> & { note: string; onClose: () => void; onNoteClear: () => void; start: string };

function NewTaskForm({ entries, id, note, onClose, onCreated, onNoteClear, start }: FormProps) {
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
  const invalidate = useInvalidateAfterWrite();

  /** The base follows the repo's own base branch until the owner types another. */
  function pick(factoryId: string, repoId: string) {
    const next = entries.find((e) => e.def.factoryId === factoryId)?.repos.find((r) => r.repoId === repoId);
    if (next && baseBranch === repo?.baseBranch) setBaseBranch(next.baseBranch);
    setFactory(factoryId);
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
      const task = await createTask(boardStore, now, { baseBranch: base, description, factoryId: entry.def.factoryId, repo: repo.repoId, title });
      clearTitle();
      clearDescription();
      clearFactory();
      clearRepo();
      clearBase();
      void invalidate();
      onCreated(task);
    } catch (error) {
      setProblem(describeWriteError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id={id} className="sf-form sf-panel" aria-label="New task" onSubmit={(event) => void submit(event)}>
      <label className="sf-field" htmlFor={`${id}-title`}>
        <span>Title</span>
        <input id={`${id}-title`} className="sf-input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="sf-field" htmlFor={`${id}-description`}>
        <span>Description</span>
        <textarea id={`${id}-description`} className="sf-input" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
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
        <label className="sf-field" htmlFor={`${id}-base`}>
          <span>Base branch</span>
          <input
            id={`${id}-base`}
            className="sf-input sf-mono"
            value={baseBranch}
            aria-invalid={baseProblem ? true : undefined}
            onChange={(event) => {
              setBaseBranch(event.target.value);
              setBaseProblem("");
            }}
          />
        </label>
      </div>
      {note ? <p role="status">{note}</p> : null}
      {baseProblem ? <p className="sf-problem" role="alert">{baseProblem}</p> : null}
      <WriteProblemNotice problem={problem} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Create task</button>
        <button type="button" className="sf-button" onClick={onClose}>Close</button>
      </div>
    </form>
  );
}
