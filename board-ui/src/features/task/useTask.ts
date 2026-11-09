import { useQuery } from "@tanstack/react-query";
import type { Approval, Doc, DocKind, FactoryEvent, Run, Task } from "@factory/core";
import { boardStore } from "../../lib/board";
import { taskKey } from "./writeOutcome";

export const DOC_KINDS: readonly DocKind[] = ["spec", "plan", "verify", "review"];

export type TaskBundle = {
  task: Task;
  /** Every version per kind, ascending; the last is the current one. */
  docs: Record<DocKind, Doc[]>;
  approvals: Approval[];
  runs: Run[];
  events: FactoryEvent[];
};

export const currentOf = (docs: readonly Doc[]): Doc | undefined => docs[docs.length - 1];

async function loadTask(taskId: string): Promise<TaskBundle> {
  const [task, spec, plan, verify, review, approvals, runs, events] = await Promise.all([
    boardStore.getTask(taskId),
    boardStore.listDocs(taskId, "spec"),
    boardStore.listDocs(taskId, "plan"),
    boardStore.listDocs(taskId, "verify"),
    boardStore.listDocs(taskId, "review"),
    boardStore.listApprovals(taskId),
    boardStore.listRuns(taskId),
    boardStore.listEvents(taskId)
  ]);
  return { approvals, docs: { plan, review, spec, verify }, events, runs, task };
}

/** One task with its docs, approvals, runs and events, refreshed every 30 seconds. */
export function useTask(taskId: string) {
  return useQuery({
    queryFn: () => loadTask(taskId),
    queryKey: taskKey(taskId),
    refetchInterval: 30_000
  });
}
