import type { Run } from "@factory/core";
import { formatCost } from "../board/status";

/** "N returns" ("1 return"), or "N of M returns" when the limit is known. */
export const attemptsLabel = (returns: number, limit?: number): string =>
  limit === undefined ? `${returns} ${returns === 1 ? "return" : "returns"}` : `${returns} of ${limit} returns`;

/** "$x", or "$x of $limit" when the limit is known. */
export const costLabel = (costUsd: number, limit?: number): string =>
  limit === undefined ? formatCost(costUsd) : `${formatCost(costUsd)} of ${formatCost(limit)}`;

/** One row of the Runs table. Every field is display text. */
export type RunRow = {
  runId: string;
  step: string;
  status: string;
  mode: string;
  agent: string;
  startedAt: string;
  turns: string;
  cost: string;
};

/** One row per run in start order; each step is numbered ("Spec v2"), and a missing turns or cost reads "—". */
export function runRows(runs: readonly Run[]): RunRow[] {
  const sorted = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const counts = new Map<string, number>();
  return sorted.map((run) => {
    const n = (counts.get(run.step) ?? 0) + 1;
    counts.set(run.step, n);
    return {
      agent: run.agent,
      cost: run.costUsd === null ? "—" : formatCost(run.costUsd),
      mode: run.mode,
      runId: run.runId,
      startedAt: run.startedAt,
      status: run.endedAt === null ? "running" : (run.result ?? "—"),
      step: `${run.step[0]!.toUpperCase()}${run.step.slice(1)} v${n}`,
      turns: run.turns === null ? "—" : String(run.turns)
    };
  });
}
