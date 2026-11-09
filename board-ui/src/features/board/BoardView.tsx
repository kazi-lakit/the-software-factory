import { useId, useState } from "react";
import type { FormEvent } from "react";
import { createTask, REPO_IDS, type RepoId, type Status, type Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { hasUnsent, useUnsent } from "../../lib/unsent";
import { describeWriteError, now, useInvalidateAfterWrite, WriteProblemNotice, type WriteProblem } from "../task/writeOutcome";
import { COLUMNS, isTestTask, MUTED, STATUS_LABEL } from "./status";
import { TaskCard } from "./TaskCard";
import { useBoard } from "./useBoard";

type Navigate = (path: string) => void;

const NEW_TASK_FIELDS = ["title", "description", "repo", "baseBranch"] as const;
const newTaskId = (field: (typeof NEW_TASK_FIELDS)[number]) => `new-task:${field}`;

/** The queue: a column per status, a repo filter, test tasks hidden by default, and the New task form. */
export function BoardView({ onNavigate }: { onNavigate: Navigate }) {
  const board = useBoard();
  const filterId = useId();
  const formId = useId();
  const [repo, setRepo] = useState<RepoId | "">("");
  const [showTest, setShowTest] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<Status>>(new Set());
  // Reopens on unsent text, e.g. after the session ended mid-form.
  const [creating, setCreating] = useState(() => NEW_TASK_FIELDS.some((f) => hasUnsent(newTaskId(f))));
  const [notice, setNotice] = useState("");

  const visible = (board.data ?? []).filter((task) => (showTest || !isTestTask(task)) && (repo === "" || task.repo === repo));
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
        <label className="sf-inline-field" htmlFor={filterId}>
          <span>Repo</span>
          <select id={filterId} className="sf-select" value={repo} onChange={(event) => setRepo(event.target.value as RepoId | "")}>
            <option value="">All repos</option>
            {REPO_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="sf-inline-field">
          <input type="checkbox" checked={showTest} onChange={(event) => setShowTest(event.target.checked)} />
          <span>Show test tasks</span>
        </label>
        <button
          type="button"
          className="sf-button sf-toolbar-end"
          aria-expanded={creating}
          aria-controls={creating ? formId : undefined}
          onClick={() => setCreating((open) => !open)}
        >
          New task
        </button>
      </div>
      <p className="sf-visually-hidden" role="status">{notice}</p>

      {creating ? (
        <NewTaskForm
          id={formId}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
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

      {board.data ? (
        <div className="sf-columns">
          {COLUMNS.map((status) => {
            const tasks = byStatus.get(status) ?? [];
            const collapsible = MUTED.has(status);
            const open = !collapsible || expanded.has(status);
            const listId = `${formId}-${status}`;
            const tone = collapsible ? " sf-column-muted" : "";
            return (
              <section key={status} className={`sf-column${tone}${open ? "" : " sf-column-collapsed"}`} aria-label={STATUS_LABEL[status]}>
                <h3 className="sf-column-head">
                  {collapsible ? (
                    <button type="button" className="sf-column-toggle" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => toggle(status)}>
                      {STATUS_LABEL[status]} ({tasks.length})
                    </button>
                  ) : (
                    <>
                      <span>{STATUS_LABEL[status]}</span>
                      <span className="sf-count sf-mono">{tasks.length}</span>
                    </>
                  )}
                </h3>
                {open && tasks.length > 0 ? (
                  <ul id={listId} className="sf-card-list">
                    {tasks.map((task) => (
                      <li key={task.taskId}><TaskCard task={task} onNavigate={onNavigate} /></li>
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

function NewTaskForm({ id, onClose, onCreated }: { id: string; onClose: () => void; onCreated: (task: Task) => void }) {
  const [title, setTitle, clearTitle] = useUnsent(newTaskId("title"));
  const [description, setDescription, clearDescription] = useUnsent(newTaskId("description"));
  const [repo, setRepo, clearRepo] = useUnsent(newTaskId("repo"), REPO_IDS[0] ?? "os");
  const [baseBranch, setBaseBranch, clearBase] = useUnsent(newTaskId("baseBranch"), "dev");
  const [problem, setProblem] = useState<WriteProblem>();
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateAfterWrite();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      // A blank base branch is left to the store's default (dev).
      const base = baseBranch.trim();
      const task = await createTask(boardStore, now, { description, repo: repo as RepoId, title, ...(base ? { baseBranch: base } : {}) });
      clearTitle();
      clearDescription();
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
        <label className="sf-field" htmlFor={`${id}-repo`}>
          <span>Repo</span>
          <select id={`${id}-repo`} className="sf-select" value={repo} onChange={(event) => setRepo(event.target.value)}>
            {REPO_IDS.map((repoId) => <option key={repoId} value={repoId}>{repoId}</option>)}
          </select>
        </label>
        <label className="sf-field" htmlFor={`${id}-base`}>
          <span>Base branch</span>
          <input id={`${id}-base`} className="sf-input sf-mono" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
        </label>
      </div>
      <WriteProblemNotice problem={problem} />
      <div className="sf-actions">
        <button type="submit" className="sf-button sf-button-primary" disabled={busy}>Create task</button>
        <button type="button" className="sf-button" onClick={onClose}>Close</button>
      </div>
    </form>
  );
}
