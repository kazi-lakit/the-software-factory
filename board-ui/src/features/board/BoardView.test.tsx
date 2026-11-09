import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@factory/core";
import { clearAllUnsent } from "../../lib/unsent";
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
});
