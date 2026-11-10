import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent, KeyboardEvent } from "react";
import {
  canMove, cancelTask, editTask, EDITABLE_STATUSES, isMainRef, markReady, normalizeDeps, type RepoId, type Task, type TaskEdit
} from "@factory/core";
import { boardStore } from "../../lib/board";
import { clearUnsent, hasUnsent, useUnsent } from "../../lib/unsent";
import { useBoard } from "../board/useBoard";
import { useFactories } from "../factories/useFactories";
import { DependsOnPicker } from "./DependsOnPicker";
import { describeWriteError, NEVER_MAIN_BASE, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "./writeOutcome";

type Reload = () => unknown;

const EDIT_FIELDS = ["title", "description", "repo", "baseBranch"] as const;
const editId = (taskId: string, field: (typeof EDIT_FIELDS)[number]) => `edit:${taskId}:${field}`;

type ActionsProps = {
  /** After a successful cancel, when the Cancel button is gone: the view moves focus (to the task heading). */
  onCancelled?: () => void;
  onReload: Reload;
  task: Task;
};

/** Mark ready (inbox), Edit (inbox or ready) and Cancel (any open task, after a confirmation). */
export function TaskActions({ onCancelled, onReload, task }: ActionsProps) {
  const canReady = canMove(task.status, "ready", "you");
  const canCancel = canMove(task.status, "cancelled", "you");
  const canEdit = EDITABLE_STATUSES.includes(task.status);
  // Reopens on unsent edits, e.g. after the session ended mid-edit.
  const [editing, setEditing] = useState(() => canEdit && EDIT_FIELDS.some((f) => hasUnsent(editId(task.taskId, f))));
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<WriteProblem>();
  const [busy, setBusy] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // Focus goes back to Cancel only once the dialog is gone and the page is no longer inert.
  const refocusCancel = useRef(false);
  const invalidate = useInvalidateAfterWrite();

  useEffect(() => {
    if (confirming || !refocusCancel.current) return;
    refocusCancel.current = false;
    cancelButton.current?.focus();
  }, [confirming]);

  if (!canReady && !canCancel && !canEdit) return null;

  async function run(write: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setProblem(undefined);
    try {
      await write();
      void invalidate(task.taskId);
      return true;
    } catch (error) {
      setProblem(describeWriteError(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function keepTask() {
    refocusCancel.current = true;
    setConfirming(false);
  }

  async function confirmCancel() {
    setConfirming(false);
    if (await run(() => cancelTask(boardStore, now, task.taskId))) onCancelled?.();
    else cancelButton.current?.focus();
  }

  return (
    <div className="sf-task-actions">
      <div className="sf-actions">
        {canReady ? (
          <button type="button" className="sf-button sf-button-primary" disabled={busy} onClick={() => void run(() => markReady(boardStore, now, task.taskId))}>
            Mark ready
          </button>
        ) : null}
        {canEdit ? (
          <button type="button" className="sf-button" aria-expanded={editing} onClick={() => setEditing((open) => !open)}>
            Edit
          </button>
        ) : null}
        {canCancel ? (
          <button ref={cancelButton} type="button" className="sf-button" disabled={busy} onClick={() => setConfirming(true)}>
            Cancel task
          </button>
        ) : null}
      </div>
      <WriteProblemNotice problem={problem} onReload={() => { setProblem(undefined); void onReload(); }} />
      {editing && canEdit ? <EditForm task={task} onReload={onReload} onDone={() => setEditing(false)} /> : null}
      {confirming ? (
        <ConfirmCancel
          taskId={task.taskId}
          onKeep={keepTask}
          onConfirm={() => void confirmCancel()}
        />
      ) : null}
    </div>
  );
}

/**
 * A modal confirmation, rendered in its own node under <body>. Everything else under <body> is inert while it
 * is open, so neither Tab nor a click can move focus behind it. Focus starts on the safe choice, Tab cycles
 * the two buttons, Escape keeps the task.
 */
function ConfirmCancel({ onConfirm, onKeep, taskId }: { onConfirm: () => void; onKeep: () => void; taskId: string }) {
  const titleId = useId();
  const textId = useId();
  const keep = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const [host] = useState(() => document.createElement("div"));

  useEffect(() => {
    document.body.appendChild(host);
    const behind = Array.from(document.body.children).filter((el) => el !== host && !el.hasAttribute("inert"));
    for (const el of behind) el.setAttribute("inert", "");
    keep.current?.focus();
    return () => {
      for (const el of behind) el.removeAttribute("inert");
      host.remove();
    };
  }, [host]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onKeep();
      return;
    }
    if (event.key !== "Tab") return;
    // Two buttons: Tab and Shift+Tab move between them and never leave the dialog.
    event.preventDefault();
    (document.activeElement === keep.current ? confirm : keep).current?.focus();
  }

  return createPortal(
    <div className="sf-dialog-backdrop">
      <div className="sf-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} onKeyDown={onKeyDown}>
        <h3 id={titleId}>Cancel {taskId}?</h3>
        <p id={textId}>The factory stops work on this task and frees its slot. A cancelled task cannot be reopened.</p>
        <div className="sf-actions">
          <button ref={keep} type="button" className="sf-button" onClick={onKeep}>Keep task</button>
          <button ref={confirm} type="button" className="sf-button sf-button-danger" onClick={onConfirm}>Yes, cancel it</button>
        </div>
      </div>
    </div>,
    host
  );
}

type EditField = (typeof EDIT_FIELDS)[number];
type Fields = Pick<Task, EditField>;
const fieldsOf = (task: Task): Fields => ({ baseBranch: task.baseBranch, description: task.description, repo: task.repo, title: task.title });

function EditForm({ onDone, onReload, task }: { onDone: () => void; onReload: Reload; task: Task }) {
  const formId = useId();
  // Each field's starting value: what the owner began editing from for a field they changed, the latest
  // stored value for one they did not. The edit is a compare-and-set on `version`.
  const [origin, setOrigin] = useState<Fields>(() => fieldsOf(task));
  const [version, setVersion] = useState(task.version);
  const fields = {
    title: useUnsent(editId(task.taskId, "title"), origin.title),
    description: useUnsent(editId(task.taskId, "description"), origin.description),
    repo: useUnsent(editId(task.taskId, "repo"), origin.repo),
    baseBranch: useUnsent(editId(task.taskId, "baseBranch"), origin.baseBranch)
  };
  const value = (field: EditField) => fields[field][0];
  const setter = (field: EditField) => fields[field][1];
  const [problem, setProblem] = useState<WriteProblem>();
  const [baseProblem, setBaseProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [depsOrigin, setDepsOrigin] = useState<string[]>(() => normalizeDeps(task.dependsOn));
  const [dependsOn, setDependsOn] = useState<string[]>(depsOrigin);
  const allTasks = useBoard().data ?? [];
  const depsChanged = () => normalizeDeps(dependsOn).join() !== depsOrigin.join();
  const invalidate = useInvalidateAfterWrite();
  // The task's own factory's repos; the current repo stays listed even when its factory is not visible.
  const factoryRepos = useFactories().byId.get(task.factoryId)?.repos.map((r) => r.repoId) ?? [];
  const repoOptions = factoryRepos.includes(value("repo")) ? factoryRepos : [value("repo"), ...factoryRepos];

  /** Only the owner's own changes, so a save never writes back a value someone else changed meanwhile. */
  const ownChanges = (): EditField[] => EDIT_FIELDS.filter((field) => value(field) !== origin[field]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const patch: TaskEdit = {};
    for (const field of ownChanges()) Object.assign(patch, { [field]: field === "repo" ? (value(field) as RepoId) : value(field) });
    if (depsChanged()) patch.dependsOn = normalizeDeps(dependsOn);
    if (patch.baseBranch !== undefined && isMainRef(patch.baseBranch)) {
      setBaseProblem(NEVER_MAIN_BASE);
      return;
    }
    setBaseProblem("");
    setBusy(true);
    setProblem(undefined);
    try {
      if (Object.keys(patch).length > 0) await editTask(boardStore, now, task.taskId, version, patch);
      clearUnsent(...EDIT_FIELDS.map((f) => editId(task.taskId, f)));
      void invalidate(task.taskId);
      onDone();
    } catch (error) {
      setProblem(describeWriteError(error));
    } finally {
      setBusy(false);
    }
  }

  // After a conflict: the owner's changed fields keep their text; the others take the latest stored values,
  // and the next save is a compare-and-set on the latest version.
  async function reload() {
    setProblem(undefined);
    const fresh = await onReload();
    if (!isTask(fresh)) return;
    const changed = new Set(ownChanges());
    const latest = fieldsOf(fresh);
    if (!depsChanged()) {
      const latestDeps = normalizeDeps(fresh.dependsOn);
      setDepsOrigin(latestDeps);
      setDependsOn(latestDeps);
    }
    const next: Fields = { ...origin };
    for (const field of EDIT_FIELDS) {
      if (changed.has(field)) continue;
      Object.assign(next, { [field]: latest[field] });
      fields[field][2](latest[field]);
    }
    setOrigin(next);
    setVersion(fresh.version);
  }

  function close() {
    clearUnsent(...EDIT_FIELDS.map((f) => editId(task.taskId, f)));
    onDone();
  }

  return (
    <form className="sf-form" aria-label="Edit task" onSubmit={(event) => void save(event)}>
      <label className="sf-field" htmlFor={`${formId}-title`}>
        <span>Title</span>
        <input id={`${formId}-title`} className="sf-input" value={value("title")} onChange={(event) => setter("title")(event.target.value)} />
      </label>
      <label className="sf-field" htmlFor={`${formId}-description`}>
        <span>Description</span>
        <textarea
          id={`${formId}-description`}
          className="sf-input"
          rows={5}
          value={value("description")}
          onChange={(event) => setter("description")(event.target.value)}
        />
      </label>
      <div className="sf-field-row">
        <label className="sf-field" htmlFor={`${formId}-repo`}>
          <span>Repo</span>
          <select id={`${formId}-repo`} className="sf-select" value={value("repo")} onChange={(event) => setter("repo")(event.target.value)}>
            {repoOptions.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="sf-field" htmlFor={`${formId}-base`}>
          <span>Base branch</span>
          <input
            id={`${formId}-base`}
            className="sf-input sf-mono"
            value={value("baseBranch")}
            aria-invalid={baseProblem ? true : undefined}
            onChange={(event) => {
              setter("baseBranch")(event.target.value);
              setBaseProblem("");
            }}
          />
        </label>
      </div>
      <DependsOnPicker id={`${formId}-deps`} factoryId={task.factoryId} selfId={task.taskId} tasks={allTasks} value={dependsOn} onChange={setDependsOn} />
      {baseProblem ? <p className="sf-problem" role="alert">{baseProblem}</p> : null}
      <WriteProblemNotice problem={problem} onReload={() => void reload()} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Save</button>
        <button type="button" className="sf-button" onClick={close}>Discard changes</button>
      </div>
    </form>
  );
}

const isTask = (value: unknown): value is Task => typeof value === "object" && value !== null && "taskId" in value && "version" in value;
