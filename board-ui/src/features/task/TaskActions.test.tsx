import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, VersionConflictError, type Task } from "@factory/core";
import { clearAllUnsent } from "../../lib/unsent";
import { factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { TaskActions } from "./TaskActions";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

function renderActions(task: Task, onReload: () => unknown = vi.fn(), onCancelled = vi.fn()) {
  const result = renderWithClient(<TaskActions task={task} onReload={onReload} onCancelled={onCancelled} />);
  return { onCancelled, onReload, ...result };
}

const stored = (task: Task) => fakeBoard().owner.getTask(task.taskId);

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  clearAllUnsent();
  vi.restoreAllMocks();
});

describe("TaskActions", () => {
  it("marks_an_inbox_task_ready", async () => {
    const task = await seedTask();
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    await waitFor(async () => expect((await stored(task)).status).toBe("ready"));
  });

  it("offers_mark_ready_and_edit_only_while_inbox_or_ready", async () => {
    const task = await seedTask({}, "build", { stage: "build" });
    renderActions(task);
    expect(screen.queryByRole("button", { name: "Mark ready" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
  });

  it("offers_nothing_on_a_finished_task", async () => {
    const task = await seedTask({}, "done");
    renderActions(task);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks_for_confirmation_before_cancelling", async () => {
    const task = await seedTask();
    renderActions(task);
    const cancel = screen.getByRole("button", { name: "Cancel task" });
    fireEvent.click(cancel);
    const dialog = screen.getByRole("dialog", { name: `Cancel ${task.taskId}?` });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("button", { name: "Keep task" })).toHaveFocus();
    expect((await stored(task)).status).toBe("inbox");

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep task" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancel).toHaveFocus();
    expect((await stored(task)).status).toBe("inbox");

    fireEvent.click(cancel);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(async () => expect((await stored(task)).status).toBe("cancelled"));
  });

  it("closes_the_confirmation_on_escape", async () => {
    const task = await seedTask();
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("edits_the_task_definition", async () => {
    const task = await seedTask({ title: "Old title" });
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit task" });
    expect(within(form).getByLabelText("Title")).toHaveValue("Old title");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "New title" } });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: "stg" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await stored(task)).toMatchObject({ baseBranch: "stg", title: "New title", version: 2 }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit task" })).not.toBeInTheDocument());
  });

  it.each(["main", " Main ", "origin/main", "refs/heads/main"])("refuses_main_as_the_base_inline (%j)", async (base) => {
    const task = await seedTask();
    const edit = vi.spyOn(fakeBoard().owner, "updateTask");
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit task" });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: base } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("never uses main");
    expect(within(form).getByLabelText("Base branch")).toHaveAttribute("aria-invalid", "true");
    expect(edit).not.toHaveBeenCalled();
    expect(await stored(task)).toMatchObject({ baseBranch: task.baseBranch, version: task.version });
  });

  it("keeps_the_edit_on_a_conflict", async () => {
    const task = await seedTask({ title: "Old title" });
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // Someone else edits the task while the form is open.
    await fakeBoard().owner.updateTask(task.taskId, task.version, { description: "changed elsewhere" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This task changed while you were looking. Reload to see the latest.");
    expect(screen.getByLabelText("Title")).toHaveValue("My title");
    expect((await stored(task)).title).toBe("Old title");
  });

  it("explains_a_refusal_from_blocks", async () => {
    const task = await seedTask();
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new ForbiddenError("FactoryTask edit refused"));
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Blocks refused this change for your account.");
  });

  it("reloads_on_a_conflict_when_asked", async () => {
    const task = await seedTask();
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new VersionConflictError(task.taskId, 1, 2));
    const onReload = vi.fn();
    renderActions(task, onReload);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it("keeps_the_other_writers_changes_after_a_reload", async () => {
    const task = await seedTask({ description: "Old description", title: "Old title" });
    renderActions(task, () => fakeBoard().owner.getTask(task.taskId));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await fakeBoard().owner.updateTask(task.taskId, task.version, { description: "changed elsewhere" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    // Fields the owner did not touch show the other writer's values; the owner's own edit stays.
    await waitFor(() => expect(screen.getByLabelText("Description")).toHaveValue("changed elsewhere"));
    expect(screen.getByLabelText("Title")).toHaveValue("My title");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await stored(task)).toMatchObject({ description: "changed elsewhere", title: "My title", version: 3 }));
  });

  it("makes_the_page_inert_behind_the_confirmation", async () => {
    const task = await seedTask();
    const { container } = renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(container).toHaveAttribute("inert");
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep task" }));
    expect(container).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Cancel task" })).toHaveFocus();
  });

  it("reports_a_successful_cancel_so_the_view_can_move_focus", async () => {
    const task = await seedTask();
    const { onCancelled } = renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
  });
});

describe("TaskActions edit with several factories", () => {
  it("lists_only_the_tasks_factorys_repos", async () => {
    resetFakeBoard(merge(factory("alpha", ["api", "web"]), factory("delta", ["api", "ui"])));
    const task = await seedTask({ factoryId: "delta", repo: "api" });
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const repo = within(screen.getByRole("form", { name: "Edit task" })).getByLabelText("Repo");
    await waitFor(() => expect(within(repo).getAllByRole("option").map((o) => o.textContent)).toEqual(["api", "ui"]));
    expect(repo).toHaveValue("api");
  });
});

describe("TaskActions styling", () => {
  it("cancel_task_is_outlined_and_not_danger", async () => {
    renderActions(await seedTask());
    const cancel = screen.getByRole("button", { name: "Cancel task" });
    expect(cancel).toHaveClass("sf-button");
    for (const filled of ["sf-button-accent", "sf-button-primary", "sf-button-danger"]) expect(cancel).not.toHaveClass(filled);
  });

  it("confirm_dialog_danger_button_unchanged", async () => {
    renderActions(await seedTask());
    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(screen.getByRole("button", { name: "Yes, cancel it" })).toHaveClass("sf-button-danger");
  });
});

describe("TaskActions dependencies", () => {
  it("saves_changed_dependencies_of_an_inbox_task", async () => {
    const dep = await seedTask({ title: "Dep" });
    const task = await seedTask({ title: "Child" });
    renderActions(task);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: new RegExp(dep.taskId) }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await stored(task)).dependsOn).toEqual([dep.taskId]));
  });

  it("has_no_picker_for_a_spec_task", async () => {
    await seedTask({ title: "Dep" });
    const task = await seedTask({}, "spec", { stage: "spec" });
    renderActions(task);
    expect(screen.queryByRole("group", { name: "Depends on" })).not.toBeInTheDocument();
  });
});
