import { describe, expect, it } from "vitest";
import type { Run } from "@factory/core";
import { attemptsLabel, costLabel, runRows } from "./taskDetails";

const run = (runId: string, step: Run["step"], startedAt: string, rest: Partial<Run> = {}): Run => ({
  agent: `${step}-agent`,
  costUsd: null,
  endedAt: "2026-11-10T12:00:00.000Z",
  mode: "sdk",
  result: "done",
  runId,
  startedAt,
  step,
  taskId: "T-1",
  turns: null,
  ...rest
});

const t = (n: number) => `2026-11-10T0${n}:00:00.000Z`;

describe("taskDetails", () => {
  it("attempts_label_without_a_limit_reads_n_returns", () => {
    expect(attemptsLabel(2)).toBe("2 returns");
    expect(attemptsLabel(0)).toBe("0 returns");
  });

  it("attempts_label_without_a_limit_is_singular_for_one", () => {
    expect(attemptsLabel(1)).toBe("1 return");
    expect(attemptsLabel(1, 3)).toBe("1 of 3 returns");
  });

  it("attempts_label_with_a_limit_reads_n_of_m_returns", () => {
    expect(attemptsLabel(2, 3)).toBe("2 of 3 returns");
  });

  it("cost_label_without_a_limit_is_the_amount", () => {
    expect(costLabel(1.5)).toBe("$1.50");
  });

  it("cost_label_with_a_limit_reads_x_of_limit", () => {
    expect(costLabel(1.5, 5)).toBe("$1.50 of $5.00");
  });

  it("run_rows_number_each_step_and_keep_start_order", () => {
    const runs = [
      run("R-1", "spec", t(1), { costUsd: 0.12, turns: 14 }),
      run("R-2", "plan", t(2), { costUsd: 0.05, turns: 3 }),
      run("R-3", "spec", t(3), { costUsd: null, endedAt: null, result: null, turns: null })
    ];
    const rows = runRows(runs);
    expect(rows.map((r) => r.step)).toEqual(["Spec v1", "Plan v1", "Spec v2"]);
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "running"]);
    expect(rows.map((r) => r.turns)).toEqual(["14", "3", "—"]);
    expect(rows.map((r) => r.cost)).toEqual(["$0.12", "$0.05", "—"]);
    expect(rows.map((r) => r.runId)).toEqual(["R-1", "R-2", "R-3"]);
    expect(rows.map((r) => r.agent)).toEqual(["spec-agent", "plan-agent", "spec-agent"]);
    expect(rows.map((r) => r.mode)).toEqual(["sdk", "sdk", "sdk"]);
    expect(rows.map((r) => r.startedAt)).toEqual([t(1), t(2), t(3)]);
  });

  it("run_rows_sort_by_start_time", () => {
    const runs = [run("R-3", "build", t(3)), run("R-1", "spec", t(1)), run("R-2", "build", t(2))];
    expect(runRows(runs).map((r) => r.step)).toEqual(["Spec v1", "Build v1", "Build v2"]);
    expect(runs.map((r) => r.runId)).toEqual(["R-3", "R-1", "R-2"]);
  });

  it("run_rows_show_a_dash_for_an_ended_run_without_result", () => {
    expect(runRows([run("R-1", "verify", t(1), { result: null })]).map((r) => r.status)).toEqual(["—"]);
  });
});
