import type { Status, Task } from "@factory/core";

/** The Board's columns, in spec §5 order. */
export const COLUMNS: readonly Status[] = [
  "inbox", "ready", "spec", "spec_review", "plan", "plan_review", "build", "verify", "review", "pr_open", "done", "blocked", "cancelled"
];

export const STATUS_LABEL: Readonly<Record<Status, string>> = {
  blocked: "Blocked",
  build: "Build",
  cancelled: "Cancelled",
  done: "Done",
  inbox: "Inbox",
  plan: "Plan",
  plan_review: "Plan review",
  pr_open: "PR open",
  ready: "Ready",
  review: "Review",
  spec: "Spec",
  spec_review: "Spec review",
  verify: "Verify"
};

/** The states that wait for the owner: the only ones that get the accent. */
export const NEEDS_YOU: ReadonlySet<Status> = new Set<Status>(["spec_review", "plan_review", "pr_open", "blocked"]);

/** Done and cancelled are muted and start collapsed. */
export const MUTED: ReadonlySet<Status> = new Set<Status>(["done", "cancelled"]);

/** Tasks the live gate test makes (`GATE-<uuid8>`); hidden unless "Show test tasks" is ticked. */
export const isTestTask = (task: Pick<Task, "taskId">): boolean => task.taskId.startsWith("GATE-");

export const taskPath = (taskId: string): string => `/tasks/${encodeURIComponent(taskId)}`;

export const formatCost = (usd: number | null): string => (usd === null ? "—" : `$${usd.toFixed(2)}`);
