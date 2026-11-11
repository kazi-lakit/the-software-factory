import type { WriteProblem } from "../task/writeOutcome";

/**
 * Set by New task when a task was created but could not be marked ready. The page is gone by then, so the task's
 * page reads it once (`peekReadyProblem` at mount) and clears it, so the notice shows a single time.
 */
let pending: { problem: WriteProblem; taskId: string } | undefined;

export function setReadyProblem(taskId: string, problem: WriteProblem): void {
  pending = { problem, taskId };
}

export function peekReadyProblem(taskId: string): WriteProblem | undefined {
  return pending?.taskId === taskId ? pending.problem : undefined;
}

export function clearReadyProblem(taskId: string): void {
  if (pending?.taskId === taskId) pending = undefined;
}
