import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, ForbiddenError, type StoredSettings } from "@factory/core";
import { setReadyProblem } from "../newTask/createdNotice";
import { describeWriteError } from "./writeOutcome";
import { clearAllUnsent } from "../../lib/unsent";
import { factory } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { TopBarLeadContext, type Lead } from "../../app/topBarLead";
import { TaskView } from "./TaskView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

function renderTask(taskId: string) {
  const onNavigate = vi.fn();
  return { onNavigate, ...renderWithClient(<TaskView taskId={taskId} onNavigate={onNavigate} />) };
}

/** The dd next to a Details term. */
const detail = (term: string) => within(screen.getByRole("region", { name: "Details" })).getByText(term).nextElementSibling as HTMLElement;
const mainHeadings = (container: HTMLElement) =>
  [...container.querySelectorAll(".sf-task-main h3")].map((h) => h.textContent);

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

    expect(await screen.findByRole("heading", { level: 1, name: "Add paging" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Your decision: approve the spec", "Plan", "Verify report", "Review report", "History", "Details", "Description", "Runs"]);

    const header = screen.getByRole("region", { name: "Task details" });
    const details = screen.getByRole("region", { name: "Details" });
    expect(within(details).getByText("factory/T-1-add-paging")).toHaveClass("sf-mono");
    expect(within(header).getByText("Spec review · waiting for you")).toBeInTheDocument();
    const pr = within(details).getByRole("link", { name: /pull\/9/ });
    expect(pr).toHaveAttribute("target", "_blank");
    expect(pr).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Page the list endpoint.")).toBeInTheDocument();

    const runs = screen.getByRole("list", { name: "Runs" });
    expect(within(runs).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Spec v1 · done · 12 turns · $1.50"]);
  });

  it.each(["javascript:alert(1)", "https://github.com.evil.test/x", "http://github.com/x", "https://evil.test/https://github.com/x"])(
    "does_not_link_the_pr_url_%s",
    async (prUrl) => {
      const task = await seedTask({}, "pr_open", { prUrl, stage: "ship" });
      renderTask(task.taskId);
      const details = await screen.findByRole("region", { name: "Details" });
      expect(within(details).queryByRole("link")).not.toBeInTheDocument();
      expect(detail("PR")).toHaveTextContent(/^Not yet$/);
    }
  );

  it("moves_focus_to_the_task_heading_after_a_cancel", async () => {
    const task = await seedTask({ title: "Drop me" });
    renderTask(task.taskId);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel task" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Drop me" })).toHaveFocus());
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
    await screen.findByRole("heading", { level: 1, name: "Open" });
    expect(screen.queryByLabelText("Your answer")).not.toBeInTheDocument();
    first.unmount();
    renderTask(blocked.taskId);
    expect(await screen.findByLabelText("Your answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Approve/ })).not.toBeInTheDocument();
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
  it("details_show_the_factory_name", async () => {
    resetFakeBoard(factory("delta", ["api"], { name: "Delta team" }));
    const task = await seedTask({ factoryId: "delta", repo: "api" });
    renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    await waitFor(() => expect(detail("Factory")).toHaveTextContent("Delta team"));
    expect(detail("Repo")).toHaveTextContent("api");
  });
});

describe("TaskView header", () => {
  it("breadcrumb_reads_board_slash_task_id_and_board_navigates_in_app", async () => {
    const task = await seedTask({ title: "Crumbs" });
    const { onNavigate } = renderTask(task.taskId);
    const nav = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(nav.textContent).toMatch(/^Board\s*\/\s*T-\d+$/);
    expect(nav.textContent).toContain(task.taskId);
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Board");
    expect(links[0]).toHaveAttribute("href", "/");
    fireEvent.click(links[0]!);
    expect(onNavigate).toHaveBeenCalledWith("/");
  });

  it("chip_row_shows_id_status_and_repo_to_base", async () => {
    const task = await seedTask({ repo: "data", title: "Chips" }, "build", { stage: "build" });
    renderTask(task.taskId);
    const chips = await screen.findByRole("list", { name: "Task summary" });
    const items = within(chips).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([task.taskId, "Build", "data → dev"]);
    expect(items[0]).toHaveClass("sf-mono");
  });

  it("status_chip_says_waiting_for_you_when_it_waits", async () => {
    const waiting = await seedTask({ title: "Waits" }, "spec_review", { stage: "spec" });
    const first = renderTask(waiting.taskId);
    const chips = await screen.findByRole("list", { name: "Task summary" });
    const status = within(chips).getAllByRole("listitem")[1]!;
    expect(status).toHaveTextContent(/^Spec review · waiting for you$/);
    expect(status).toHaveClass("sf-chip-waiting");
    first.unmount();
    const building = await seedTask({ title: "Builds" }, "build", { stage: "build" });
    renderTask(building.taskId);
    const other = within(await screen.findByRole("list", { name: "Task summary" })).getAllByRole("listitem")[1]!;
    expect(other).toHaveTextContent(/^Build$/);
    expect(other).not.toHaveClass("sf-chip-waiting");
  });

  it("title_is_an_h1_with_the_page_title_style", async () => {
    const task = await seedTask({ title: "Big title" });
    renderTask(task.taskId);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Big title" });
    expect(h1).toHaveClass("sf-page-title");
    expect(h1).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("edit_and_cancel_sit_on_the_title_row", async () => {
    const task = await seedTask({ title: "Row" });
    renderTask(task.taskId);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Row" });
    const row = h1.parentElement as HTMLElement;
    expect(row).toHaveClass("sf-task-title-row");
    const edit = within(row).getByRole("button", { name: "Edit" });
    expect(edit).toHaveClass("sf-button");
    expect(edit).not.toHaveClass("sf-button-primary");
    expect(edit).not.toHaveClass("sf-button-danger");
    expect(within(row).getByRole("button", { name: "Cancel task" })).toHaveClass("sf-button-danger");
  });

  it("old_facts_and_meta_line_are_gone", async () => {
    const task = await seedTask({ title: "Plain" }, "build", { attempt: 1, branch: "factory/T-9-x", costUsd: 2.25, stage: "build" });
    const { container } = renderTask(task.taskId);
    const header = await screen.findByRole("region", { name: "Task details" });
    expect(container.querySelector(".sf-facts")).toBeNull();
    expect(container.querySelector(".sf-task-meta")).toBeNull();
    for (const term of ["Attempt", "Stage", "Last event", "Repo", "Base", "Branch", "Cost"]) expect(within(header).queryByText(term)).not.toBeInTheDocument();
  });

  it("stepper_labels_show_context_on_the_task_page", async () => {
    const task = await seedTask({ title: "Steps" }, "spec_review", { stage: "spec" });
    const { core } = fakeBoard();
    await core.addDoc(task.taskId, "spec", "# Spec\nOne.", "spec-agent");
    await core.addDoc(task.taskId, "spec", "# Spec\nTwo.", "spec-agent");
    renderTask(task.taskId);
    const header = await screen.findByRole("region", { name: "Task details" });
    const stepper = within(header).getByRole("img");
    expect(stepper).toHaveTextContent("Spec · v2 waiting");
    expect(stepper).toHaveTextContent("PR into dev");
  });
});

describe("TaskView page layout", () => {
  it("details_list_branch_and_cost", async () => {
    const task = await seedTask({ title: "Details" }, "build", { branch: "factory/T-9-x", costUsd: 2.25, stage: "build" });
    renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    expect(detail("Branch")).toHaveTextContent("factory/T-9-x");
    expect(detail("Cost")).toHaveTextContent(/^\$2\.25/);
    expect(detail("Cost")).toHaveClass("sf-mono");
  });

  it("details_show_a_dash_without_a_branch", async () => {
    const task = await seedTask({ title: "Bare" });
    renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    expect(detail("Branch")).toHaveTextContent("—");
  });

  it("no_document_still_shows_details", async () => {
    const task = await seedTask({ title: "No docs" });
    renderTask(task.taskId);
    expect(await screen.findByRole("region", { name: "Details" })).toBeInTheDocument();
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
    await screen.findByRole("heading", { level: 1, name: "Building" });
    expect(container.querySelectorAll('.sf-step[data-state="waiting"]')).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: /Your decision/ })).not.toBeInTheDocument();
  });

  it("done_task_shows_six_done_steps", async () => {
    const task = await seedTask({ title: "Finished" }, "done", { stage: "ship" });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Finished" });
    expect(container.querySelectorAll('.sf-step[data-state="done"]')).toHaveLength(6);
  });

  it("cancelled_task_shows_no_waiting_step", async () => {
    const task = await seedTask({ title: "Dropped" }, "cancelled", { stage: "build" });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Dropped" });
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
    await screen.findByRole("heading", { level: 1, name: "Gate" });
    const steps = [...container.querySelectorAll(".sf-step")].map((el) => el.getAttribute("data-state"));
    expect(steps[index]).toBe("waiting");
  });
});

describe("TaskView body", () => {
  const settingsWith = (settings: StoredSettings) => vi.spyOn(fakeBoard().owner, "getSettings").mockResolvedValue(settings);

  it("main_column_starts_with_the_decision_panel_at_a_gate", async () => {
    const task = await seedTask({ title: "Decide" }, "spec_review", { stage: "spec" });
    await fakeBoard().core.addDoc(task.taskId, "spec", "# Spec\nOne.", "spec-agent");
    const { container } = renderTask(task.taskId);
    const panel = await screen.findByRole("region", { name: "Your decision: approve the spec" });
    expect(container.querySelector(".sf-task-main")!.firstElementChild).toBe(panel);
    expect(panel).toHaveClass("sf-panel-decision");
  });

  it("gate_doc_is_not_shown_twice", async () => {
    const spec = await seedTask({ title: "Spec gate" }, "spec_review", { stage: "spec" });
    await fakeBoard().core.addDoc(spec.taskId, "spec", "# Spec\nOne.", "spec-agent");
    const first = renderTask(spec.taskId);
    await screen.findByRole("heading", { level: 1, name: "Spec gate" });
    let main = mainHeadings(first.container);
    expect(main).not.toContain("Spec");
    expect(main).toEqual(expect.arrayContaining(["Plan", "Verify report", "Review report"]));
    first.unmount();

    const plan = await seedTask({ title: "Plan gate" }, "plan_review", { stage: "plan" });
    await fakeBoard().core.addDoc(plan.taskId, "plan", "# Plan\nOne.", "planner");
    const second = renderTask(plan.taskId);
    await screen.findByRole("heading", { level: 1, name: "Plan gate" });
    main = mainHeadings(second.container);
    expect(main).not.toContain("Plan");
    expect(main).toContain("Spec");
    second.unmount();

    const created = await fakeBoard().owner.createTask({ baseBranch: "feature/x", description: "", factoryId: "blocks", repo: "data", title: "PR gate" });
    await fakeBoard().core.updateTask(created.taskId, created.version, { stage: "ship", status: "pr_open" });
    const third = renderTask(created.taskId);
    await screen.findByRole("heading", { level: 1, name: "PR gate" });
    main = mainHeadings(third.container);
    expect(main).not.toContain("Review report");
    expect(main).toContain("Verify report");
  });

  it("non_gate_task_shows_all_four_doc_sections", async () => {
    const task = await seedTask({ title: "Building" }, "build", { stage: "build" });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Building" });
    expect(mainHeadings(container)).toEqual(["Spec", "Plan", "Verify report", "Review report", "History"]);
  });

  it("blocked_task_main_column_starts_with_the_answer_panel", async () => {
    const task = await seedTask({ title: "Stuck" }, "blocked", { question: "Open now?", stage: "plan" });
    await fakeBoard().core.addEvents([
      { action: "set", actor: "planner", at: "2026-11-01T10:00:00.000Z", factoryId: "blocks", field: "question", from: null, reason: "asked", taskId: task.taskId, to: "Earlier?" },
      { action: "set", actor: "you", at: "2026-11-02T10:00:00.000Z", factoryId: "blocks", field: "answer", from: null, reason: "answered", taskId: task.taskId, to: "yes" }
    ]);
    const { container } = renderTask(task.taskId);
    const panel = await screen.findByRole("region", { name: "Open now?" });
    const main = container.querySelector(".sf-task-main") as HTMLElement;
    expect(main.firstElementChild).toBe(panel);
    const log = screen.getByRole("region", { name: "Questions and answers" });
    const spec = screen.getByRole("region", { name: "Spec" });
    const history = screen.getByRole("region", { name: "History" });
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(panel, log)).toBe(true);
    expect(follows(log, spec)).toBe(true);
    expect(follows(spec, history)).toBe(true);
    expect(main).toContainElement(history);
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("side_column_has_details_description_runs_in_order", async () => {
    const task = await seedTask({ title: "Sides" });
    const { container } = renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Sides" });
    const side = container.querySelector(".sf-task-side") as HTMLElement;
    const main = container.querySelector(".sf-task-main") as HTMLElement;
    expect(side.tagName).toBe("ASIDE");
    expect(main.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...side.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Details", "Description", "Runs"]);
  });

  it("description_panel_shows_the_text_or_no_description", async () => {
    const task = await seedTask({ description: "Do the thing.", title: "Described" });
    const first = renderTask(task.taskId);
    const panel = await screen.findByRole("region", { name: "Description" });
    expect(panel).toHaveTextContent("Do the thing.");
    first.unmount();
    const bare = await seedTask({ title: "Bare" });
    renderTask(bare.taskId);
    expect(await screen.findByRole("region", { name: "Description" })).toHaveTextContent("No description.");
  });

  it("details_list_repo_base_branch_factory_pr", async () => {
    const task = await seedTask({ title: "Facts" });
    renderTask(task.taskId);
    const details = await screen.findByRole("region", { name: "Details" });
    expect([...details.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Repo", "Base", "Branch", "Factory", "PR", "Attempts", "Cost"]);
    expect(detail("Base")).toHaveClass("sf-mono");
    expect(detail("Base")).toHaveTextContent(/^dev$/);
    expect(detail("PR")).toHaveTextContent(/^Not yet$/);
  });

  it("waits_for_shows_only_with_dependencies", async () => {
    const lone = await seedTask({ title: "Lone" });
    const first = renderTask(lone.taskId);
    await screen.findByRole("region", { name: "Details" });
    expect(screen.queryByText("Waits for")).toBeNull();
    first.unmount();

    const { core, owner } = fakeBoard();
    const dep = await seedTask({ title: "Dep" }, "build", { stage: "build" });
    const child = await owner.createTask({ dependsOn: [dep.taskId], description: "", factoryId: "blocks", repo: "data", title: "Child" });
    await core.updateTask(child.taskId, child.version, { status: "ready" });
    const { onNavigate } = renderTask(child.taskId);
    await screen.findByRole("region", { name: "Details" });
    const waits = detail("Waits for");
    const link = within(waits).getByRole("link", { name: dep.taskId });
    await waitFor(() => expect(link.closest("li")).toHaveTextContent("Build"));
    await waitFor(() => expect(within(waits).getByText(`Waiting on ${dep.taskId}`)).toBeInTheDocument());
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith(`/tasks/${dep.taskId}`);
  });

  it("attempts_reads_n_returns", async () => {
    const task = await seedTask({ title: "Tries" }, "build", { attempt: 2, stage: "build" });
    renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    expect(detail("Attempts")).toHaveTextContent(/^2 returns$/);
  });

  it("cost_shows_the_resolved_limit_once_settings_load", async () => {
    const factorySettings = { ...DEFAULT_SETTINGS, maxCostPerTaskUsd: 8 };
    const task = await seedTask({ repo: "data", title: "Costs" }, "build", { costUsd: 1.5, stage: "build" });

    const spy = settingsWith({ factories: { blocks: { factory: factorySettings, repos: { data: { maxCostPerTaskUsd: 3 } } } } });
    const first = renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    await waitFor(() => expect(detail("Cost")).toHaveTextContent(/^\$1\.50 of \$3\.00$/));
    first.unmount();

    spy.mockResolvedValue({ factories: { blocks: { factory: factorySettings, repos: {} } } });
    const second = renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    await waitFor(() => expect(detail("Cost")).toHaveTextContent(/^\$1\.50 of \$8\.00$/));
    second.unmount();

    spy.mockResolvedValue({ factories: {} });
    renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    await waitFor(() => expect(detail("Cost")).toHaveTextContent(/^\$1\.50 of \$5\.00$/));
  });

  it("cost_shows_the_amount_alone_while_settings_load_or_fail", async () => {
    const task = await seedTask({ title: "Costs" }, "build", { costUsd: 1.5, stage: "build" });
    const spy = vi.spyOn(fakeBoard().owner, "getSettings").mockReturnValue(new Promise(() => undefined));
    const first = renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    expect(detail("Cost")).toHaveTextContent(/^\$1\.50$/);
    first.unmount();

    spy.mockRejectedValue(new Error("boom"));
    renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(detail("Cost")).toHaveTextContent(/^\$1\.50$/);
  });

  it("last_event_row_is_gone", async () => {
    const task = await seedTask({ title: "Events" });
    renderTask(task.taskId);
    await screen.findByRole("region", { name: "Details" });
    expect(screen.queryByText("Last event")).toBeNull();
  });

  it("runs_are_short_lines_in_start_order", async () => {
    const task = await seedTask({ title: "Runs" }, "build", { stage: "build" });
    const { core } = fakeBoard();
    const first = await core.startRun({ agent: "spec-writer", mode: "sdk", step: "spec", taskId: task.taskId });
    await core.finishRun(first.runId, { costUsd: 0.12, result: "done", turns: 14 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await core.startRun({ agent: "spec-writer", mode: "sdk", step: "spec", taskId: task.taskId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await core.startRun({ agent: "planner", mode: "sdk", step: "plan", taskId: task.taskId });
    const { container } = renderTask(task.taskId);
    const runs = await screen.findByRole("list", { name: "Runs" });
    const lines = within(runs).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual(["Spec v1 · done · 14 turns · $0.12", "Spec v2 · running", "Plan v1 · running"]);
    expect(container.querySelector("table")).toBeNull();
  });

  it("runs_say_no_runs_yet", async () => {
    const task = await seedTask({ title: "Idle" });
    renderTask(task.taskId);
    expect(await screen.findByRole("region", { name: "Runs" })).toHaveTextContent("No runs yet.");
  });
});

describe("TaskView dependencies", () => {
  it("links_each_dependency_with_its_status", async () => {
    const { owner } = fakeBoard();
    const dep = await seedTask({ title: "Dep" }, "build", { stage: "build" });
    const t = await owner.createTask({ dependsOn: [dep.taskId], description: "", factoryId: "blocks", repo: "data", title: "Child" });
    const { onNavigate } = renderTask(t.taskId);
    const details = await screen.findByRole("region", { name: "Details" });
    const link = within(details).getByRole("link", { name: new RegExp(dep.taskId) });
    expect(link).toHaveAttribute("href", `/tasks/${dep.taskId}`);
    await waitFor(() => expect(link.closest("li")).toHaveTextContent("Build"));
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith(`/tasks/${dep.taskId}`);
  });
});

describe("TaskView questions and answers", () => {
  const LETTERED = "Which branch?\nA. main: fits (recommended)\nB. develop: more work";
  const at = (n: number) => `2026-11-0${n}T10:00:00.000Z`;
  const qa = (taskId: string, field: "question" | "answer", to: string, n: number, reason = field === "answer" ? "answered" : "asked") => ({
    action: "set" as const, actor: field === "question" ? "spec-writer · sdk · run R-1" : "you", at: at(n), factoryId: "blocks", field, from: null, reason, taskId, to
  });

  it("shows_the_qa_log_under_the_answer_panel_when_blocked", async () => {
    const task = await seedTask({ title: "Stuck" }, "blocked", { question: "Open now?", stage: "plan" });
    await fakeBoard().core.addEvents([qa(task.taskId, "question", LETTERED, 1), qa(task.taskId, "answer", "A. main: fits", 2), qa(task.taskId, "question", "Open now?", 3)]);
    renderTask(task.taskId);
    const log = await screen.findByRole("region", { name: "Questions and answers" });
    expect(within(log).getByText("Which branch?")).toBeInTheDocument();
    expect(within(log).getByText("A. main: fits")).toBeInTheDocument();
    expect(within(log).getByText("Recommended")).toBeInTheDocument();
    expect(within(log).queryByText("Open now?")).toBeNull();
    const panel = screen.getByRole("region", { name: "Open now?" });
    expect(panel.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("non_blocked_task_with_past_answers_shows_the_log_without_a_panel", async () => {
    const task = await seedTask({ title: "Moving" }, "plan", { stage: "plan" });
    await fakeBoard().core.addEvents([qa(task.taskId, "question", "Continue?", 1), qa(task.taskId, "answer", "yes", 2)]);
    renderTask(task.taskId);
    expect(await screen.findByRole("region", { name: "Questions and answers" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Your answer")).toBeNull();
  });

  it("no_qa_section_when_there_are_no_entries", async () => {
    const task = await seedTask({ title: "Quiet" });
    renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Quiet" });
    expect(screen.queryByRole("region", { name: "Questions and answers" })).toBeNull();
  });

  it("gate_changes_requested_answer_is_not_in_the_log", async () => {
    const task = await seedTask({ title: "Gate" }, "plan", { stage: "plan" });
    await fakeBoard().core.addEvents([qa(task.taskId, "answer", "please change X", 1, "spec changes requested")]);
    renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Gate" });
    expect(screen.queryByRole("region", { name: "Questions and answers" })).toBeNull();
    expect(screen.queryByText("please change X")).toBeNull();
  });

  describe("top bar Back", () => {
    function renderWithLead(taskId: string) {
      const onNavigate = vi.fn();
      const leads: Array<Lead | null> = [];
      const setter = (lead: Lead | null) => void leads.push(lead);
      const view = renderWithClient(
        <TopBarLeadContext.Provider value={setter}>
          <TaskView taskId={taskId} onNavigate={onNavigate} />
        </TopBarLeadContext.Provider>
      );
      return { leads, onNavigate, ...view };
    }

    it("registers_Back_when_loaded_and_navigates_to_the_board", async () => {
      const task = await seedTask({ title: "Back me" });
      const { leads, onNavigate } = renderWithLead(task.taskId);
      await screen.findByRole("heading", { level: 1, name: "Back me" });
      const lead = leads[leads.length - 1];
      expect(lead?.label).toBe("Back");
      lead?.onClick();
      expect(onNavigate).toHaveBeenCalledWith("/");
    });

    it("registers_Back_while_loading", () => {
      const { leads } = renderWithLead("T-1");
      expect(screen.getByRole("status")).toHaveTextContent("Loading T-1");
      expect(leads[0]?.label).toBe("Back");
    });

    it("registers_Back_when_the_task_is_not_found", async () => {
      const { leads } = renderWithLead("T-404");
      await screen.findByText(/was not found/);
      expect(leads[leads.length - 1]?.label).toBe("Back");
    });

    it("registers_Back_when_loading_failed", async () => {
      vi.spyOn(fakeBoard().owner, "getTask").mockRejectedValue(new Error("boom"));
      const { leads } = renderWithLead("T-1");
      await screen.findByText(/Could not load/);
      expect(leads[leads.length - 1]?.label).toBe("Back");
    });

    it("clears_the_lead_on_unmount", async () => {
      const { leads, unmount } = renderWithLead("T-404");
      await screen.findByText(/was not found/);
      unmount();
      expect(leads[leads.length - 1]).toBeNull();
    });
  });
});

describe("TaskView after New task", () => {
  it("shows_the_not_marked_ready_notice_once_after_create", async () => {
    const task = await seedTask({ title: "Fresh" });
    setReadyProblem(task.taskId, describeWriteError(new ForbiddenError("no")));
    renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Fresh" });
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent ?? "");
    expect(alerts.some((t) => t.includes("The task was created but not marked ready."))).toBe(true);
    expect(alerts.some((t) => t.includes("Blocks refused this change for your account."))).toBe(true);
    cleanup();
    renderTask(task.taskId);
    await screen.findByRole("heading", { level: 1, name: "Fresh" });
    expect(screen.queryByText("The task was created but not marked ready.")).not.toBeInTheDocument();
  });
});
