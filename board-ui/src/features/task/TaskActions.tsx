import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  canMove, cancelTask, editTask, EDITABLE_STATUSES, markReady, REPO_IDS, type RepoId, type Task, type TaskEdit
} from "@factory/core";
import { boardStore } from "../../lib/board";
import { clearUnsent, hasUnsent, useUnsent } from "../../lib/unsent";
import { describeWriteError, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "./writeOutcome";

type Reload = () => unknown;

const EDIT_FIELDS = ["title", "description", "repo", "baseBranch"] as const;
const editId = (taskId: string, field: (typeof EDIT_FIELDS)[number]) => `edit:${taskId}:${field}`;

/** Mark ready (inbox), Edit (inbox or ready) and Cancel (any open task, after a confirmation). */
export function TaskActions({ onReload, task }: { onReload: Reload; task: Task }) {
  const canReady = canMove(task.status, "ready", "you");
  const canCancel = canMove(task.status, "cancelled", "you");
  const canEdit = EDITABLE_STATUSES.includes(task.status);
  // Reopens on unsent edits, e.g. after the session ended mid-edit.
  const [editing, setEditing] = useState(() => canEdit && EDIT_FIELDS.some((f) => hasUnsent(editId(task.taskId, f))));
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<WriteProblem>();
  const [busy, setBusy] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const invalidate = useInvalidateAfterWrite();

  if (!canReady && !canCancel && !canEdit) return null;

  async function run(write: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await write();
      void invalidate(task.taskId);
    } catch (error) {
      setProblem(describeWriteError(error));
    } finally {
      setBusy(false);
    }
  }

  function closeConfirm() {
    setConfirming(false);
    cancelButton.current?.focus();
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
          onKeep={closeConfirm}
          onConfirm={() => {
            closeConfirm();
            void run(() => cancelTask(boardStore, now, task.taskId));
          }}
        />
      ) : null}
    </div>
  );
}

/** A modal confirmation: focus starts on the safe choice, Tab stays inside, Escape keeps the task. */
function ConfirmCancel({ onConfirm, onKeep, taskId }: { onConfirm: () => void; onKeep: () => void; taskId: string }) {
  const titleId = useId();
  const textId = useId();
  const keep = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    keep.current?.focus();
  }, []);

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

  return (
    <div className="sf-dialog-backdrop">
      <div className="sf-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} onKeyDown={onKeyDown}>
        <h3 id={titleId}>Cancel {taskId}?</h3>
        <p id={textId}>The factory stops work on this task and frees its slot. A cancelled task cannot be reopened.</p>
        <div className="sf-actions">
          <button ref={keep} type="button" className="sf-button" onClick={onKeep}>Keep task</button>
          <button ref={confirm} type="button" className="sf-button sf-button-danger" onClick={onConfirm}>Yes, cancel it</button>
        </div>
      </div>
    </div>
  );
}

type Base = Pick<Task, "version" | (typeof EDIT_FIELDS)[number]>;
const baseOf = (task: Task): Base => ({ baseBranch: task.baseBranch, description: task.description, repo: task.repo, title: task.title, version: task.version });

function EditForm({ onDone, onReload, task }: { onDone: () => void; onReload: Reload; task: Task }) {
  const formId = useId();
  // The task as the owner saw it when the form opened: the edit is a compare-and-set on its version.
  const [base, setBase] = useState<Base>(() => baseOf(task));
  const [title, setTitle] = useUnsent(editId(task.taskId, "title"), base.title);
  const [description, setDescription] = useUnsent(editId(task.taskId, "description"), base.description);
  const [repo, setRepo] = useUnsent(editId(task.taskId, "repo"), base.repo);
  const [baseBranch, setBaseBranch] = useUnsent(editId(task.taskId, "baseBranch"), base.baseBranch);
  const [problem, setProblem] = useState<WriteProblem>();
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateAfterWrite();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = { baseBranch, description, repo: repo as RepoId, title };
    const patch: TaskEdit = {};
    for (const field of EDIT_FIELDS) {
      if (values[field] !== base[field]) Object.assign(patch, { [field]: values[field] });
    }
    setBusy(true);
    setProblem(undefined);
    try {
      if (Object.keys(patch).length > 0) await editTask(boardStore, now, task.taskId, base.version, patch);
      clearUnsent(...EDIT_FIELDS.map((f) => editId(task.taskId, f)));
      void invalidate(task.taskId);
      onDone();
    } catch (error) {
      setProblem(describeWriteError(error));
    } finally {
      setBusy(false);
    }
  }

  // The typed values stay; the form now edits the latest version.
  async function reload() {
    setProblem(undefined);
    const fresh = await onReload();
    setBase(isTask(fresh) ? baseOf(fresh) : baseOf(task));
  }

  function close() {
    clearUnsent(...EDIT_FIELDS.map((f) => editId(task.taskId, f)));
    onDone();
  }

  return (
    <form className="sf-form" aria-label="Edit task" onSubmit={(event) => void save(event)}>
      <label className="sf-field" htmlFor={`${formId}-title`}>
        <span>Title</span>
        <input id={`${formId}-title`} className="sf-input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="sf-field" htmlFor={`${formId}-description`}>
        <span>Description</span>
        <textarea id={`${formId}-description`} className="sf-input" rows={5} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <div className="sf-field-row">
        <label className="sf-field" htmlFor={`${formId}-repo`}>
          <span>Repo</span>
          <select id={`${formId}-repo`} className="sf-select" value={repo} onChange={(event) => setRepo(event.target.value)}>
            {REPO_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="sf-field" htmlFor={`${formId}-base`}>
          <span>Base branch</span>
          <input id={`${formId}-base`} className="sf-input sf-mono" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
        </label>
      </div>
      <WriteProblemNotice problem={problem} onReload={() => void reload()} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Save</button>
        <button type="button" className="sf-button" onClick={close}>Discard changes</button>
      </div>
    </form>
  );
}

const isTask = (value: unknown): value is Task => typeof value === "object" && value !== null && "taskId" in value && "version" in value;
