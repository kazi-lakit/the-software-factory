import type { Status, Task } from "@factory/core";

export type LaneId = "needs-you" | "queued" | "working" | "done" | "stopped";

export type Lane = { id: LaneId; name: string; hint?: string; statuses: readonly Status[] };

/** The Lanes view: every status sits in exactly one lane. */
export const LANES: readonly Lane[] = [
  { hint: "Oldest first. Tap a task to act on it.", id: "needs-you", name: "Needs you", statuses: ["spec_review", "plan_review", "pr_open", "blocked"] },
  { hint: "Inbox needs Mark ready; ready tasks start when a slot frees.", id: "queued", name: "Queued", statuses: ["inbox", "ready"] },
  { id: "working", name: "Working", statuses: ["spec", "plan", "build", "verify", "review"] },
  { hint: "Finished and merged", id: "done", name: "Done", statuses: ["done"] },
  { hint: "Cancelled tasks. Kept for history.", id: "stopped", name: "Stopped", statuses: ["cancelled"] }
];

const LANE_OF = new Map<string, LaneId>(LANES.flatMap((lane) => lane.statuses.map((status) => [status, lane.id] as const)));

/** The lane for a status; a status not in the list (runtime safety net) counts as Working. */
export const laneOf = (status: Status): LaneId => LANE_OF.get(status) ?? "working";

const number = (taskId: string): number => Number(/(\d+)$/.exec(taskId)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** Oldest first: task ids are one rising sequence, so the lowest number has waited longest. */
export const byAge = (a: Pick<Task, "taskId">, b: Pick<Task, "taskId">): number => number(a.taskId) - number(b.taskId) || a.taskId.localeCompare(b.taskId);
