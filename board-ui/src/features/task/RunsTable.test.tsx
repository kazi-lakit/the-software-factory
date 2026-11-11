import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "@factory/core";
import { formatWhenShort } from "../../lib/formatTime";
import { RunsTable } from "./RunsTable";
import { runRows } from "./taskDetails";

const now = new Date(2026, 10, 12, 18, 0);

const run = (runId: string, step: Run["step"], startedAt: Date, rest: Partial<Run> = {}): Run => ({
  agent: `${step}-agent`,
  costUsd: null,
  endedAt: "2026-11-12T12:00:00.000Z",
  mode: "sdk",
  result: "done",
  runId,
  startedAt: startedAt.toISOString(),
  step,
  taskId: "T-1",
  turns: null,
  ...rest
});

afterEach(cleanup);

describe("RunsTable", () => {
  it("shows_one_row_per_run_in_start_order", () => {
    const runs = [
      run("R-3", "spec", new Date(2026, 10, 12, 11, 0), { endedAt: null, result: null }),
      run("R-1", "spec", new Date(2026, 10, 12, 9, 0), { costUsd: 0.12, turns: 14 }),
      run("R-2", "plan", new Date(2026, 10, 12, 10, 0), { costUsd: 0.05, turns: 3 })
    ];
    render(<RunsTable runs={runs} now={now} />);
    const table = screen.getByRole("table", { name: "Runs" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(
      ["Step", "Status", "Mode", "Agent", "Started", "Turns", "Cost"]
    );
    const rows = within(table).getAllByRole("row").slice(1);
    const cells = rows.map((row) => within(row).getAllByRole("cell").map((c) => c.textContent));
    expect(cells).toEqual(
      runRows(runs).map((r) => [r.step, r.status, r.mode, r.agent, formatWhenShort(r.startedAt, now), r.turns, r.cost])
    );
    expect(cells.map((c) => c[0])).toEqual(["Spec v1", "Plan v1", "Spec v2"]);
  });

  it("says_no_runs_yet", () => {
    render(<RunsTable runs={[]} now={now} />);
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
