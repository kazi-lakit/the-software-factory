import type { Run } from "@factory/core";
import { formatCost } from "../board/status";

/** "N returns", or "N of M returns" when the limit is known. */
export const attemptsLabel = (returns: number, limit?: number): string =>
  limit === undefined ? `${returns} returns` : `${returns} of ${limit} returns`;

/** "$x", or "$x of $limit" when the limit is known. */
export const costLabel = (costUsd: number, limit?: number): string =>
  limit === undefined ? formatCost(costUsd) : `${formatCost(costUsd)} of ${formatCost(limit)}`;

/** One short line per run in start order, e.g. "Spec v2 · done · 14 turns · $0.12". */
export function runLines(runs: readonly Run[]): { runId: string; text: string }[] {
  const sorted = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const counts = new Map<string, number>();
  return sorted.map((run) => {
    const n = (counts.get(run.step) ?? 0) + 1;
    counts.set(run.step, n);
    const parts = [`${run.step[0]!.toUpperCase()}${run.step.slice(1)} v${n}`, run.endedAt === null ? "running" : (run.result ?? "—")];
    if (run.turns !== null) parts.push(`${run.turns} turns`);
    if (run.costUsd !== null) parts.push(formatCost(run.costUsd));
    return { runId: run.runId, text: parts.join(" · ") };
  });
}
