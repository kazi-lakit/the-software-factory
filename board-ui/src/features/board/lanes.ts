import type { Status } from "@factory/core";

export type LaneId = "needs-you" | "queued" | "working" | "done" | "stopped";

export type Lane = { id: LaneId; name: string; hint: string; statuses: readonly Status[] };

/** The Lanes view: every status sits in exactly one lane. */
export const LANES: readonly Lane[] = [
  { hint: "Waiting for your review or answer", id: "needs-you", name: "Needs you", statuses: ["spec_review", "plan_review", "pr_open", "blocked"] },
  { hint: "New tasks wait here to start", id: "queued", name: "Queued", statuses: ["inbox", "ready"] },
  { hint: "The factory is on it", id: "working", name: "Working", statuses: ["spec", "plan", "build", "verify", "review"] },
  { hint: "Finished and merged", id: "done", name: "Done", statuses: ["done"] },
  { hint: "Cancelled tasks", id: "stopped", name: "Stopped", statuses: ["cancelled"] }
];

const LANE_OF = new Map<string, LaneId>(LANES.flatMap((lane) => lane.statuses.map((status) => [status, lane.id] as const)));

/** The lane for a status; a status not in the list (runtime safety net) counts as Working. */
export const laneOf = (status: Status): LaneId => LANE_OF.get(status) ?? "working";
