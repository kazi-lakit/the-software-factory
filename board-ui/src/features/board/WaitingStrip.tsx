import type { Task } from "@factory/core";
import { followInApp } from "./TaskCard";
import { NEEDS_YOU, STATUS_LABEL, taskPath } from "./status";

const number = (taskId: string): number => Number(/(\d+)$/.exec(taskId)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** Oldest first: task ids are one rising sequence, so the lowest number has waited longest. */
export const byAge = (a: Task, b: Task): number => number(a.taskId) - number(b.taskId) || a.taskId.localeCompare(b.taskId);

/** The tasks that wait for the owner (`NEEDS_YOU`), above the columns. Not rendered when none does. */
export function WaitingStrip({ onNavigate, showFactory, tasks }: { onNavigate: (path: string) => void; showFactory: boolean; tasks: readonly Task[] }) {
  const waiting = tasks.filter((task) => NEEDS_YOU.has(task.status)).sort(byAge);
  if (waiting.length === 0) return null;
  return (
    <nav className="sf-strip" aria-label="Waiting for you">
      <ul className="sf-strip-list">
        {waiting.map((task) => {
          const href = taskPath(task.taskId);
          return (
            <li key={task.taskId} className="sf-strip-item">
              <span className="sf-mono sf-strip-id">{showFactory ? `${task.factoryId} · ${task.taskId}` : task.taskId}</span>
              <a href={href} onClick={(event) => followInApp(event, href, onNavigate)}>{task.title}</a>
              <span className="sf-strip-status">{STATUS_LABEL[task.status]}</span>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
