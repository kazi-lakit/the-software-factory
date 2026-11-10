import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllUnsent } from "../../lib/unsent";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { TaskView } from "./TaskView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

function renderTask(taskId: string) {
  const onNavigate = vi.fn();
  return { onNavigate, ...renderWithClient(<TaskView taskId={taskId} onNavigate={onNavigate} />) };
}

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  clearAllUnsent();
  vi.restoreAllMocks();
});

describe("TaskView", () => {
  it("shows_the_sections_in_order", async () => {
    const task = await seedTask({ description: "Page the list endpoint.", title: "Add paging" }, "spec_review", {
      attempt: 1, branch: "factory/T-1-add-paging", costUsd: 1.5, prUrl: "https://github.com/SELISEdigitalplatforms/blocks-data/pull/9", stage: "spec"
    });
    const { core } = fakeBoard();
    await core.addDoc(task.taskId, "spec", "# Spec\nPaging.", "spec-agent");
    const run = await core.startRun({ agent: "spec-agent", mode: "sdk", step: "spec", taskId: task.taskId });
    await core.finishRun(run.runId, { costUsd: 1.5, result: "done", turns: 12 });
    renderTask(task.taskId);

    expect(await screen.findByRole("heading", { level: 2, name: "Add paging" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Description", "Spec", "Plan", "Verify report", "Review report", "Your decision: spec", "Runs", "History"]);

    const header = screen.getByRole("region", { name: "Task details" });
    expect(within(header).getByText(task.taskId)).toHaveClass("sf-mono");
    expect(within(header).getByText("factory/T-1-add-paging")).toHaveClass("sf-mono");
    expect(within(header).getByText("$1.50")).toHaveClass("sf-mono");
    expect(within(header).getByText("Spec review")).toBeInTheDocument();
    const pr = within(header).getByRole("link", { name: /pull\/9/ });
    expect(pr).toHaveAttribute("target", "_blank");
    expect(pr).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Page the list endpoint.")).toBeInTheDocument();

    const runs = screen.getByRole("table", { name: "Runs" });
    expect(within(runs).getByText("spec-agent")).toBeInTheDocument();
    expect(within(runs).getByText("12")).toBeInTheDocument();
  });

  it.each(["javascript:alert(1)", "https://github.com.evil.test/x", "http://github.com/x", "https://evil.test/https://github.com/x"])(
    "does_not_link_the_pr_url_%s",
    async (prUrl) => {
      const task = await seedTask({}, "pr_open", { prUrl, stage: "ship" });
      renderTask(task.taskId);
      const header = await screen.findByRole("region", { name: "Task details" });
      expect(within(header).queryByRole("link")).not.toBeInTheDocument();
    }
  );

  it("moves_focus_to_the_task_heading_after_a_cancel", async () => {
    const task = await seedTask({ title: "Drop me" });
    renderTask(task.taskId);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel task" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Drop me" })).toHaveFocus());
  });

  it("lists_the_history_newest_first", async () => {
    const task = await seedTask({ title: "History" });
    const { owner } = fakeBoard();
    await owner.addEvents([
      { action: "move", actor: "you", factoryId: "blocks", at: "2026-11-10T09:00:00.000Z", field: "status", from: "inbox", reason: "marked ready", taskId: task.taskId, to: "ready" },
      { action: "move", actor: "core", factoryId: "blocks", at: "2026-11-10T10:00:00.000Z", field: "status", from: "ready", reason: "claimed", taskId: task.taskId, to: "spec" }
    ]);
    renderTask(task.taskId);
    const history = await screen.findByRole("list", { name: "History" });
    const items = within(history).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items[0]).toContain("claimed");
    expect(items[1]).toContain("marked ready");
  });

  it("shows_the_answer_panel_only_when_blocked", async () => {
    const open = await seedTask({ title: "Open" });
    const blocked = await seedTask({ title: "Stuck" }, "blocked", { question: "Which base?", stage: "plan" });
    const first = renderTask(open.taskId);
    await screen.findByRole("heading", { level: 2, name: "Open" });
    expect(screen.queryByLabelText("Your answer")).not.toBeInTheDocument();
    first.unmount();
    renderTask(blocked.taskId);
    expect(await screen.findByLabelText("Your answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("refreshes_the_task_after_a_write", async () => {
    const task = await seedTask({ title: "Ready me" });
    renderTask(task.taskId);
    fireEvent.click(await screen.findByRole("button", { name: "Mark ready" }));
    const header = screen.getByRole("region", { name: "Task details" });
    await waitFor(() => expect(within(header).getByText("Ready")).toBeInTheDocument());
  });

  it("says_when_the_task_does_not_exist", async () => {
    const { onNavigate } = renderTask("T-404");
    expect(await screen.findByText(/was not found/)).toHaveTextContent("Task T-404 was not found.");
    fireEvent.click(screen.getByRole("link", { name: "Back to the Board" }));
    expect(onNavigate).toHaveBeenCalledWith("/");
  });
});
