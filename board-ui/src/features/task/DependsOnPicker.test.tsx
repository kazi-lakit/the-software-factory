import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@factory/core";
import { DependsOnPicker } from "./DependsOnPicker";

function task(taskId: string, patch: Partial<Task> = {}): Task {
  return {
    answer: null, attempt: 0, baseBranch: "dev", blockedReason: null, branch: null, claimBy: null, claimUntil: null, costUsd: 0,
    description: "", factoryId: "blocks", gateOverrides: {}, dependsOn: [], prUrl: null, question: null, repo: "data", stage: null, status: "inbox",
    taskId, title: `Title ${taskId}`, version: 1, ...patch
  };
}

afterEach(cleanup);

const labels = () => screen.getAllByRole("checkbox").map((el) => (el as HTMLInputElement).value);

describe("DependsOnPicker", () => {
  it("lists_open_same_factory_tasks_without_self_and_keeps_selected_finished_ones", () => {
    const tasks = [
      task("T-1"), task("T-2", { status: "done" }), task("T-3", { status: "cancelled" }), task("T-4", { factoryId: "other" }),
      task("T-5"), task("T-6", { status: "done" })
    ];
    render(<DependsOnPicker id="x" factoryId="blocks" selfId="T-5" tasks={tasks} value={["T-6"]} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Depends on" })).toBeInTheDocument();
    expect(labels().sort()).toEqual(["T-1", "T-6"]);
    expect(screen.getByRole("checkbox", { name: /T-6/ })).toBeChecked();
  });

  it("reports_every_checked_id", () => {
    const onChange = vi.fn();
    function Host() {
      const [value, setValue] = useState<string[]>([]);
      return <DependsOnPicker id="x" factoryId="blocks" tasks={[task("T-1"), task("T-2")]} value={value} onChange={(ids) => { onChange(ids); setValue(ids); }} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("checkbox", { name: /T-1/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /T-2/ }));
    expect(onChange).toHaveBeenLastCalledWith(["T-1", "T-2"]);
  });

  it("shows_a_selected_id_that_no_longer_exists_so_it_can_be_unticked", () => {
    const onChange = vi.fn();
    render(<DependsOnPicker id="x" factoryId="blocks" tasks={[task("T-1")]} value={["T-1", "T-9"]} onChange={onChange} />);
    const missing = screen.getByRole("checkbox", { name: "T-9 (missing)" });
    expect(missing).toBeChecked();
    fireEvent.click(missing);
    expect(onChange).toHaveBeenCalledWith(["T-1"]);
  });
});
