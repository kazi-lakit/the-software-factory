import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@factory/core";
import { clearAllUnsent, keepUnsent } from "../../lib/unsent";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { BoardView } from "./BoardView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const ORDER = ["Inbox", "Ready", "Spec", "Spec review", "Plan", "Plan review", "Build", "Verify", "Review", "PR open", "Done", "Blocked", "Cancelled"];

function renderBoard() {
  const onNavigate = vi.fn();
  return { onNavigate, ...renderWithClient(<BoardView onNavigate={onNavigate} />) };
}

const column = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  clearAllUnsent();
  vi.restoreAllMocks();
});

describe("BoardView", () => {
  it("renders_a_column_per_status_in_spec_order", async () => {
    await seedTask({ title: "First" });
    renderBoard();
    await screen.findByText("First");
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(ORDER);
  });

  it("places_each_task_in_its_status_column", async () => {
    await seedTask({ title: "Needs review" }, "spec_review", { stage: "spec" });
    await seedTask({ title: "Fresh" });
    renderBoard();
    await screen.findByText("Needs review");
    expect(within(column("Spec review")).getByText("Needs review")).toBeInTheDocument();
    expect(within(column("Inbox")).getByText("Fresh")).toBeInTheDocument();
  });

  it("hides_gate_test_tasks_until_show_test_tasks_is_ticked", async () => {
    await seedTask({ title: "Real work" });
    fakeBoard().ownerData.seed("FactoryTask", {
      attempt: 0, baseBranch: "dev", costUsd: 0, description: "", gateOverrides: "{}", repo: "data", status: "inbox",
      taskId: "GATE-1a2b3c4d", title: "Gate probe", version: 1
    });
    renderBoard();
    await screen.findByText("Real work");
    expect(screen.queryByText("Gate probe")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    expect(screen.getByText("Gate probe")).toBeInTheDocument();
  });

  it("collapses_done_and_cancelled_with_their_counts", async () => {
    await seedTask({ title: "Shipped" }, "done");
    await seedTask({ title: "Dropped" }, "cancelled");
    renderBoard();
    const done = await screen.findByRole("button", { name: "Done (1)" });
    expect(done).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Cancelled (1)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Shipped")).not.toBeInTheDocument();
    fireEvent.click(done);
    expect(done).toHaveAttribute("aria-expanded", "true");
    expect(within(column("Done")).getByText("Shipped")).toBeInTheDocument();
    expect(screen.queryByText("Dropped")).not.toBeInTheDocument();
  });

  it("filters_by_repo", async () => {
    await seedTask({ repo: "data", title: "Data work" });
    await seedTask({ repo: "iam", title: "IAM work" });
    renderBoard();
    await screen.findByText("Data work");
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "iam" } });
    expect(screen.queryByText("Data work")).not.toBeInTheDocument();
    expect(screen.getByText("IAM work")).toBeInTheDocument();
  });

  it("creates_a_task_from_the_new_task_form_and_shows_its_card", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = screen.getByRole("form", { name: "New task" });
    expect(within(form).getByLabelText("Base branch")).toHaveValue("dev");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Add paging" } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Page the list endpoint." } });
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "iam" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await within(column("Inbox")).findByText("Add paging")).toBeInTheDocument();
    const [stored] = await fakeBoard().owner.listTasks();
    expect(stored).toMatchObject({ baseBranch: "dev", description: "Page the list endpoint.", repo: "iam", title: "Add paging" });
    expect(await fakeBoard().owner.listEvents(stored!.taskId)).toEqual([expect.objectContaining({ action: "create", actor: "you" })]);
    expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument();
  });

  it("asks_for_a_title_before_creating", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("title must not be blank");
    expect(await fakeBoard().owner.listTasks()).toEqual([]);
  });

  it("keeps_the_form_text_when_blocks_refuses_it", async () => {
    vi.spyOn(fakeBoard().owner, "createTask").mockRejectedValue(new ForbiddenError("no"));
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Blocks refused this change for your account.");
    expect(screen.getByLabelText("Title")).toHaveValue("Keep me");
  });

  it("opens_a_task_from_its_card", async () => {
    const task = await seedTask({ title: "Open me" });
    const { onNavigate } = renderBoard();
    fireEvent.click(await screen.findByRole("link", { name: "Open me" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(`/tasks/${task.taskId}`));
  });

  it("returns_focus_to_new_task_after_creating", async () => {
    renderBoard();
    const open = await screen.findByRole("button", { name: "New task" });
    fireEvent.click(open);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Focus me" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument());
    expect(open).toHaveFocus();
  });

  it("points_aria_controls_only_at_a_rendered_list", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    const done = await screen.findByRole("button", { name: "Done (1)" });
    const cancelled = screen.getByRole("button", { name: "Cancelled (0)" });
    expect(done).not.toHaveAttribute("aria-controls");
    fireEvent.click(done);
    const listId = done.getAttribute("aria-controls");
    expect(listId && document.getElementById(listId)).toBeTruthy();
    fireEvent.click(cancelled);
    expect(cancelled).not.toHaveAttribute("aria-controls");
  });
});

describe("BoardView new-task link", () => {
  const link = (query: string) => window.history.replaceState({}, "", `/?${query}`);
  const params = (values: Record<string, string>) => new URLSearchParams({ new: "1", ...values }).toString();
  const openForm = () => screen.findByRole("form", { name: "New task" });

  it("opens_the_form_prefilled_from_the_link", async () => {
    link(params({ base: "stg", description: "Fix it & more\nline two #1 é", repo: "iam", title: "Fix the typo" }));
    renderBoard();
    const form = await openForm();
    expect(within(form).getByLabelText("Title")).toHaveValue("Fix the typo");
    expect(within(form).getByLabelText("Description")).toHaveValue("Fix it & more\nline two #1 é");
    expect(within(form).getByLabelText("Repo")).toHaveValue("iam");
    expect(within(form).getByLabelText("Base branch")).toHaveValue("stg");
  });

  it("falls_back_to_the_default_repo_and_shows_a_note_for_an_unknown_repo", async () => {
    link(params({ repo: "nope", title: "T" }));
    renderBoard();
    const form = await openForm();
    expect(within(form).getByLabelText("Repo")).toHaveValue("os");
    expect(screen.getByText('Unknown repo "nope" in the link; pick one.')).toBeInTheDocument();
  });

  it("trims_the_base_and_uses_dev_when_it_is_empty", async () => {
    link(params({ base: "   ", title: "T" }));
    renderBoard();
    expect(within(await openForm()).getByLabelText("Base branch")).toHaveValue("dev");
    cleanup();
    clearAllUnsent();
    link(params({ base: "  stg  ", title: "T" }));
    renderBoard();
    expect(within(await openForm()).getByLabelText("Base branch")).toHaveValue("stg");
  });

  it("caps_the_title_at_200_and_the_description_at_8000", async () => {
    link(params({ description: "d".repeat(9000), title: "t".repeat(300) }));
    renderBoard();
    const form = await openForm();
    expect((within(form).getByLabelText("Title") as HTMLInputElement).value).toHaveLength(200);
    expect((within(form).getByLabelText("Description") as HTMLTextAreaElement).value).toHaveLength(8000);
  });

  it("clears_the_parameters_from_the_address_bar_after_reading_them", async () => {
    link(params({ title: "T" }));
    renderBoard();
    await openForm();
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/");
  });

  it("replaces_unsent_draft_text_with_the_link", async () => {
    keepUnsent("new-task:title", "old draft");
    keepUnsent("new-task:description", "old description");
    link(params({ title: "From the link" }));
    renderBoard();
    const form = await openForm();
    expect(within(form).getByLabelText("Title")).toHaveValue("From the link");
    expect(within(form).getByLabelText("Description")).toHaveValue("");
  });

  it("opens_no_form_without_new_1", async () => {
    link(params({ title: "T" }).replace("new=1", "new=0"));
    renderBoard();
    await screen.findByRole("button", { name: "New task" });
    expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument();
    link("title=T");
    cleanup();
    renderBoard();
    await screen.findByRole("button", { name: "New task" });
    expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument();
  });

  it("creates_nothing_until_create_task_is_clicked", async () => {
    link(params({ description: "D", repo: "data", title: "Drafted" }));
    renderBoard();
    const form = await openForm();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await fakeBoard().owner.listTasks()).toEqual([]);
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await within(column("Inbox")).findByText("Drafted")).toBeInTheDocument();
    expect(await fakeBoard().owner.listTasks()).toEqual([expect.objectContaining({ description: "D", repo: "data", title: "Drafted" })]);
  });
});
