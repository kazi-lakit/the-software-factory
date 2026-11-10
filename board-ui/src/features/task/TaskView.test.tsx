import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllUnsent } from "../../lib/unsent";
import { factory } from "../../test/factories";
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
    const details = screen.getByRole("complementary", { name: "Details" });
    expect(within(details).getByText("factory/T-1-add-paging")).toHaveClass("sf-mono");
    expect(within(details).getByText("$1.50")).toHaveClass("sf-mono");
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

describe("TaskView factory", () => {
  it("shows_the_factory_name_next_to_the_repo", async () => {
    resetFakeBoard(factory("delta", ["api"], { name: "Delta team" }));
    const task = await seedTask({ factoryId: "delta", repo: "api" });
    renderTask(task.taskId);
    const header = await screen.findByRole("region", { name: "Task details" });
    await waitFor(() => expect(within(header).getByText("Factory").nextElementSibling).toHaveTextContent("Delta team"));
    expect(header.querySelector(".sf-task-meta")).toHaveTextContent("api");
  });
});

const DAY = 86_400_000;
const createEvent = (taskId: string, at: string) =>
  ({ action: "create", actor: "you", factoryId: "blocks", at, field: null, from: null, reason: "", taskId, to: "inbox" }) as const;

describe("TaskView page layout", () => {
  it("title_h2_has_the_title_class_and_meta_line_under_it", async () => {
    const task = await seedTask({ repo: "data", title: "Meta me" });
    const { owner } = fakeBoard();
    await owner.addEvents([createEvent(task.taskId, new Date(Date.now() - 2 * DAY - 60_000).toISOString())]);
    renderTask(task.taskId);
    const h2 = await screen.findByRole("heading", { level: 2, name: "Meta me" });
    const meta = h2.nextElementSibling as HTMLElement;
    expect(meta).toHaveClass("sf-task-meta");
    expect(meta).toHaveTextContent("data");
    expect(within(meta).getByText("dev")).toHaveClass("sf-mono");
    await waitFor(() => expect(meta).toHaveTextContent("2d"));
  });

  it("meta_line_omits_age_without_a_create_event", async () => {
    const task = await seedTask({ title: "No age" });
    const { owner } = fakeBoard();
    await owner.addEvents([{ ...createEvent(task.taskId, "not a date") }]);
    renderTask(task.taskId);
    const h2 = await screen.findByRole("heading", { level: 2, name: "No age" });
    const meta = h2.nextElementSibling as HTMLElement;
    expect(meta.textContent).not.toMatch(/NaN|undefined/);
    expect(meta.textContent).not.toMatch(/·\s*$/);
  });

  it("details_lists_branch_cost_last_event", async () => {
    const task = await seedTask({ title: "Details" }, "build", { branch: "factory/T-9-x", costUsd: 2.25, stage: "build" });
    const { owner } = fakeBoard();
    await owner.addEvents([
      { action: "move", actor: "core", factoryId: "blocks", at: "2026-11-10T10:00:00.000Z", field: "status", from: "ready", reason: "", taskId: task.taskId, to: "spec" },
      { action: "move", actor: "core", factoryId: "blocks", at: "2099-01-01T10:00:00.000Z", field: "status", from: "spec", reason: "", taskId: task.taskId, to: "plan" }
    ]);
    renderTask(task.taskId);
    const details = await screen.findByRole("complementary", { name: "Details" });
    expect(within(details).getByText("Branch").nextElementSibling).toHaveTextContent("factory/T-9-x");
    expect(within(details).getByText("Cost").nextElementSibling).toHaveTextContent("$2.25");
    const last = within(details).getByText("Last event").nextElementSibling as HTMLElement;
    expect(last).toHaveTextContent("status: plan");
    expect(last).toHaveTextContent(new Date("2099-01-01T10:00:00.000Z").toLocaleString());
  });

  it("details_show_dashes_when_branch_cost_events_missing", async () => {
    const task = await seedTask({ title: "Bare" });
    renderTask(task.taskId);
    const details = await screen.findByRole("complementary", { name: "Details" });
    expect(within(details).getByText("Branch").nextElementSibling).toHaveTextContent("—");
    expect(within(details).getByText("Last event").nextElementSibling).toHaveTextContent(/^—$|created in/);
  });

  it("header_facts_no_longer_repeat_repo_base_branch_cost", async () => {
    const task = await seedTask({ title: "Once" }, "build", { branch: "factory/T-9-x", costUsd: 2.25, stage: "build" });
    renderTask(task.taskId);
    const header = await screen.findByRole("region", { name: "Task details" });
    for (const term of ["Repo", "Base", "Branch", "Cost"]) expect(within(header).queryByText(term)).not.toBeInTheDocument();
  });

  it("no_document_still_shows_details", async () => {
    const task = await seedTask({ title: "No docs" });
    renderTask(task.taskId);
    expect(await screen.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByText("No spec yet.")).toBeInTheDocument();
  });

  it("shows_the_six_step_stepper_in_the_header", async () => {
    const task = await seedTask({ title: "Steps" }, "plan_review", { stage: "plan" });
    renderTask(task.taskId);
    const header = await screen.findByRole("region", { name: "Task details" });
    expect(within(header).getByRole("img", { name: "Progress: Plan, step 2 of 6" })).toBeInTheDocument();
  });

  it("build_task_shows_no_accent_step_and_no_decision_panel", async () => {
    const task = await seedTask({ title: "Building" }, "build", { stage: "build" });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 2, name: "Building" });
    expect(container.querySelectorAll('.sf-step[data-state="waiting"]')).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: /Your decision/ })).not.toBeInTheDocument();
  });

  it("done_task_shows_six_done_steps", async () => {
    const task = await seedTask({ title: "Finished" }, "done", { stage: "ship" });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 2, name: "Finished" });
    expect(container.querySelectorAll('.sf-step[data-state="done"]')).toHaveLength(6);
  });

  it("cancelled_task_shows_no_waiting_step", async () => {
    const task = await seedTask({ title: "Dropped" }, "cancelled", { stage: "build" });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 2, name: "Dropped" });
    expect(container.querySelectorAll('.sf-step[data-state="waiting"]')).toHaveLength(0);
  });

  it("blocked_task_with_question_shows_waiting_step_and_answer_panel", async () => {
    const task = await seedTask({ title: "Stuck" }, "blocked", { question: "Which base?", stage: "build" });
    const { container } = renderTask(task.taskId);
    expect(await screen.findByLabelText("Your answer")).toBeInTheDocument();
    expect(container.querySelectorAll('.sf-step[data-state="waiting"]')).toHaveLength(1);
  });

  it.each([["spec_review", "spec", 0], ["plan_review", "plan", 1]] as const)("%s_waiting_step_is_the_gate_step", async (status, stage, index) => {
    const task = await seedTask({ title: "Gate" }, status, { stage });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 2, name: "Gate" });
    const steps = [...container.querySelectorAll(".sf-step")].map((el) => el.getAttribute("data-state"));
    expect(steps[index]).toBe("waiting");
  });
});
