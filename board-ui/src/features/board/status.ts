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

/** The six steps of the card's progress bar. */
export const STEPS = ["Spec", "Plan", "Build", "Verify", "Review", "PR"] as const;
export type StepState = "done" | "current" | "waiting" | "todo";

const STAGE_STEP: Readonly<Record<string, number>> = { spec: 0, plan: 1, build: 2, check: 2, verify: 3, review: 4, ship: 5 };
const STATUS_STEP: Readonly<Partial<Record<Status, number>>> = {
  build: 2, plan: 1, plan_review: 1, pr_open: 5, review: 4, spec: 0, spec_review: 0, verify: 3
};

/** The step a status or stage points at, or null when none does. */
function stepIndex(status: Status, stage: Task["stage"]): number | null {
  if (status === "blocked" || status === "cancelled") return stage ? (STAGE_STEP[stage] ?? null) : null;
  return STATUS_STEP[status] ?? null;
}

/** The state of each of the six steps for a task (A3). */
export function progressSteps(status: Status, stage: Task["stage"]): StepState[] {
  if (status === "done") return STEPS.map(() => "done");
  const at = stepIndex(status, stage);
  const mark: StepState = NEEDS_YOU.has(status) ? "waiting" : "current";
  return STEPS.map((_, i) => {
    if (at === null) return "todo";
    if (i < at) return "done";
    if (i === at) return status === "cancelled" ? "todo" : mark;
    return "todo";
  });
}

/** The accessible name of the progress bar. */
export function progressLabel(status: Status, stage: Task["stage"]): string {
  if (status === "done") return "Progress: done";
  const at = stepIndex(status, stage);
  if (status === "cancelled" || at === null) return status === "inbox" || status === "ready" ? "Progress: not started" : "Progress: stopped";
  return `Progress: ${STEPS[at]}, step ${at + 1} of 6`;
}

/** The call-to-action for a task that waits for the owner, or null. */
export function ctaLabel(status: Status, question: string | null): string | null {
  if (status === "spec_review") return "Review the spec";
  if (status === "plan_review") return "Review the plan";
  if (status === "pr_open") return "Review the PR";
  if (status === "blocked") return question?.trim() ? "Answer the question" : "See why it stopped";
  return null;
}
