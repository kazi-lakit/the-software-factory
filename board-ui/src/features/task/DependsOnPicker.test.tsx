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

const optionValues = (select: HTMLElement) =>
  [...(select as HTMLSelectElement).options].map((o) => o.value).filter((v) => v !== "");

describe("DependsOnPicker", () => {
  it("lists_open_same_factory_tasks_without_self_and_keeps_selected_finished_ones", () => {
    const tasks = [
      task("T-1"), task("T-2", { status: "done" }), task("T-3", { status: "cancelled" }), task("T-4", { factoryId: "other" }),
      task("T-5"), task("T-6", { status: "done" })
    ];
    render(<DependsOnPicker id="x" factoryId="blocks" selfId="T-5" tasks={tasks} value={["T-6"]} onChange={vi.fn()} />);
    const select = screen.getByLabelText("Depends on");
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveClass("sf-select");
    expect(optionValues(select)).toEqual(["T-1"]);
    const chip = screen.getByText("T-6 · Title T-6").closest(".sf-chip");
    expect(chip).not.toBeNull();
    const remove = screen.getByRole("button", { name: "Remove T-6" });
    expect(remove).toHaveClass("sf-chip-remove");
    expect(chip).toContainElement(remove);
  });

  it("picking_an_option_adds_it_and_remove_drops_it", () => {
    const onChange = vi.fn();
    function Host() {
      const [value, setValue] = useState<string[]>([]);
      return <DependsOnPicker id="x" factoryId="blocks" tasks={[task("T-1"), task("T-2")]} value={value} onChange={(ids) => { onChange(ids); setValue(ids); }} />;
    }
    render(<Host />);
    const select = screen.getByLabelText("Depends on");
    fireEvent.change(select, { target: { value: "T-1" } });
    fireEvent.change(select, { target: { value: "T-2" } });
    expect(onChange).toHaveBeenLastCalledWith(["T-1", "T-2"]);
    expect(optionValues(screen.getByLabelText("Depends on"))).not.toContain("T-1");
    fireEvent.click(screen.getByRole("button", { name: "Remove T-1" }));
    expect(onChange).toHaveBeenLastCalledWith(["T-2"]);
  });

  it("shows_a_selected_id_that_no_longer_exists_as_a_removable_chip", () => {
    const onChange = vi.fn();
    render(<DependsOnPicker id="x" factoryId="blocks" tasks={[task("T-1")]} value={["T-1", "T-9"]} onChange={onChange} />);
    expect(screen.getByText("T-9 (missing)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove T-9" }));
    expect(onChange).toHaveBeenCalledWith(["T-1"]);
  });

  it("uses_the_label_prop", () => {
    render(<DependsOnPicker id="x" label="Waits for" factoryId="blocks" tasks={[task("T-1")]} value={[]} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Waits for").tagName).toBe("SELECT");
  });

  it("renders_nothing_without_options_or_missing", () => {
    const { container } = render(<DependsOnPicker id="x" factoryId="blocks" tasks={[]} value={[]} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
