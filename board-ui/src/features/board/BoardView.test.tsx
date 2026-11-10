import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@factory/core";
import { clearAllUnsent, keepUnsent } from "../../lib/unsent";
import { factory, merge } from "../../test/factories";
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
  window.localStorage.clear();
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
    expect(await within(await screen.findByRole("region", { name: "Spec review" })).findByText("Needs review")).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "blocks/iam" } });
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
    expect(within(form).getByLabelText("Repo")).toHaveValue("data");
    expect(screen.getByText('Unknown repo "nope" in the link; pick one.')).toBeInTheDocument();
  });

  it("caps_the_repo_shown_in_the_note_at_40_characters", async () => {
    link(params({ repo: "r".repeat(100), title: "T" }));
    renderBoard();
    await openForm();
    expect(screen.getByText(`Unknown repo "${"r".repeat(40)}" in the link; pick one.`)).toBeInTheDocument();
  });

  it("clears_the_note_on_a_repo_change_and_on_close", async () => {
    link(params({ repo: "nope", title: "T" }));
    renderBoard();
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "iam" } });
    expect(screen.queryByText(/Unknown repo/)).not.toBeInTheDocument();
    cleanup();
    clearAllUnsent();
    link(params({ repo: "nope", title: "T" }));
    renderBoard();
    fireEvent.click(within(await openForm()).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.queryByText(/Unknown repo/)).not.toBeInTheDocument();
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

const two = () => merge(factory("alpha", ["api", "web"], { name: "Alpha" }), factory("delta", ["api", "ui"], { name: "Delta" }));
async function pickFactory(value: string) {
  const select = screen.getByLabelText("Factory", { selector: "select" });
  await waitFor(() => expect(select.querySelector(`option[value="${value}"]`)).not.toBeNull());
  fireEvent.change(select, { target: { value } });
}

describe("BoardView factories", () => {
  it("persists_the_picked_factory_and_restores_it", async () => {
    resetFakeBoard(two());
    await seedTask({ factoryId: "alpha", repo: "api", title: "Alpha work" });
    await seedTask({ factoryId: "delta", repo: "api", title: "Delta work" });
    renderBoard();
    await screen.findByText("Alpha work");
    await pickFactory("delta");
    expect(screen.queryByText("Alpha work")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("factory-board:factory")).toBe("delta");
    cleanup();
    renderBoard();
    expect(await screen.findByText("Delta work")).toBeInTheDocument();
    expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("delta");
    expect(screen.queryByText("Alpha work")).not.toBeInTheDocument();
  });

  it("lists_the_selected_factorys_repos_in_the_repo_filter_and_every_pair_under_all", async () => {
    resetFakeBoard(two());
    renderBoard();
    const repo = await screen.findByLabelText("Repo");
    const options = () => within(repo).getAllByRole("option").map((o) => o.textContent);
    await waitFor(() => expect(options()).toEqual(["All repos", "alpha/api", "alpha/web", "delta/api", "delta/ui"]));
    await pickFactory("delta");
    expect(options()).toEqual(["All repos", "api", "ui"]);
  });

  it("tags_cards_with_their_factory_under_all_only", async () => {
    resetFakeBoard(two());
    const task = await seedTask({ factoryId: "delta", repo: "ui", title: "Tagged" });
    renderBoard();
    expect(await within(await screen.findByRole("region", { name: "Inbox" })).findByText(`delta · ${task.taskId}`)).toBeInTheDocument();
    await pickFactory("delta");
    expect(within(column("Inbox")).getByText(task.taskId)).toBeInTheDocument();
    expect(screen.queryByText(`delta · ${task.taskId}`)).not.toBeInTheDocument();
  });

  it("hides_factories_that_fail_validation_but_still_shows_their_tasks_under_all", async () => {
    resetFakeBoard(merge(two(), factory("GATE-gate", ["api"])));
    const task = await seedTask({ factoryId: "alpha", repo: "api", title: "Normal" });
    fakeBoard().ownerData.seed("FactoryTask", {
      attempt: 0, baseBranch: "dev", costUsd: 0, description: "", factoryId: "ghost", gateOverrides: "{}", repo: "x", status: "inbox",
      taskId: "T-90", title: "Orphan", version: 1
    });
    renderBoard();
    expect(await screen.findByText("Orphan")).toBeInTheDocument();
    expect(screen.getByText("ghost · T-90")).toBeInTheDocument();
    expect(task.taskId).toBeTruthy();
    const names = within(screen.getByLabelText("Factory", { selector: "select" })).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["All factories", "Alpha", "Delta"]);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const form = await openNewForm();
    expect(within(within(form).getByLabelText("Factory")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Alpha", "Delta"]);
  });
});

const openNewForm = () => screen.findByRole("form", { name: "New task" });

describe("BoardView waiting strip", () => {
  it("lists_a_blocked_task_of_another_factory_with_a_working_link", async () => {
    resetFakeBoard(two());
    await seedTask({ factoryId: "alpha", repo: "api", title: "Quiet" });
    const blocked = await seedTask({ factoryId: "delta", repo: "ui", title: "Stuck" }, "blocked", { question: "Which way?" });
    const { onNavigate } = renderBoard();
    const strip = await screen.findByRole("navigation", { name: "Waiting for you" });
    expect(within(strip).getByText(`delta · ${blocked.taskId}`)).toBeInTheDocument();
    expect(within(strip).getByText("Blocked")).toBeInTheDocument();
    expect(within(strip).queryByText("Quiet")).not.toBeInTheDocument();
    fireEvent.click(within(strip).getByRole("link", { name: "Stuck" }));
    expect(onNavigate).toHaveBeenCalledWith(`/tasks/${blocked.taskId}`);
  });

  it("follows_the_picked_factory_and_lists_oldest_first", async () => {
    resetFakeBoard(two());
    await seedTask({ factoryId: "alpha", repo: "api", title: "First" }, "blocked", { question: "q" });
    await seedTask({ factoryId: "delta", repo: "ui", title: "Second" }, "spec_review", { stage: "spec" });
    await seedTask({ factoryId: "alpha", repo: "web", title: "Third" }, "pr_open", { stage: "ship" });
    renderBoard();
    const strip = await screen.findByRole("navigation", { name: "Waiting for you" });
    expect(within(strip).getAllByRole("link").map((a) => a.textContent)).toEqual(["First", "Second", "Third"]);
    await pickFactory("alpha");
    expect(within(screen.getByRole("navigation", { name: "Waiting for you" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["First", "Third"]);
  });

  it("is_not_rendered_when_nothing_needs_you", async () => {
    await seedTask({ title: "Fresh" });
    renderBoard();
    await screen.findByText("Fresh");
    expect(screen.queryByRole("navigation", { name: "Waiting for you" })).not.toBeInTheDocument();
  });
});

describe("BoardView New task with several factories", () => {
  it("lists_only_the_chosen_factorys_repos_and_creates_in_that_factory", async () => {
    resetFakeBoard(two());
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = await openNewForm();
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    expect(within(within(form).getByLabelText("Repo")).getAllByRole("option").map((o) => o.textContent)).toEqual(["api", "ui"]);
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "In delta" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await within(column("Inbox")).findByText("In delta");
    expect(await fakeBoard().owner.listTasks()).toEqual([expect.objectContaining({ factoryId: "delta", repo: "api", title: "In delta" })]);
  });

  it("starts_in_the_picked_factory", async () => {
    resetFakeBoard(two());
    renderBoard();
    await screen.findByRole("option", { name: "Delta" });
    await pickFactory("delta");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(within(await openNewForm()).getByLabelText("Factory")).toHaveValue("delta");
  });

  it("keeps_the_right_factory_for_an_api_repo_that_two_factories_have", async () => {
    resetFakeBoard(two());
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = await openNewForm();
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "api" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Delta api" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await within(column("Inbox")).findByText("Delta api");
    expect((await fakeBoard().owner.listTasks())[0]).toMatchObject({ factoryId: "delta", repo: "api" });
  });

  it("defaults_the_base_to_the_repos_base_branch_and_follows_a_repo_change", async () => {
    resetFakeBoard({ defs: two().defs, repos: [...two().repos.filter((r) => r.factoryId !== "delta"), ...factory("delta", ["api"]).repos.map((r) => ({ ...r, baseBranch: "stg" })), ...factory("delta", ["ui"]).repos] });
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = await openNewForm();
    const base = within(form).getByLabelText("Base branch");
    expect(base).toHaveValue("dev");
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    expect(base).toHaveValue("stg");
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "ui" } });
    expect(base).toHaveValue("dev");
    fireEvent.change(base, { target: { value: "release/1" } });
    fireEvent.change(within(form).getByLabelText("Repo"), { target: { value: "api" } });
    expect(base).toHaveValue("release/1");
  });

  it("refuses_main_as_the_base_inline", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = await openNewForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "T" } });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: " Main " } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("never uses main");
    expect(await fakeBoard().owner.listTasks()).toEqual([]);
  });
});

describe("BoardView new-task link with factories", () => {
  const link = (query: string) => window.history.replaceState({}, "", `/?${new URLSearchParams({ new: "1", ...Object.fromEntries(new URLSearchParams(query)) })}`);

  it("prefills_the_factory_and_then_its_repo", async () => {
    resetFakeBoard(two());
    link("factory=delta&repo=ui&title=T");
    renderBoard();
    const form = await openNewForm();
    expect(within(form).getByLabelText("Factory")).toHaveValue("delta");
    expect(within(form).getByLabelText("Repo")).toHaveValue("ui");
    expect(screen.queryByText(/Unknown/)).not.toBeInTheDocument();
  });

  it("shows_a_capped_note_for_an_unknown_factory_and_clears_it_on_change", async () => {
    resetFakeBoard(two());
    link(`factory=${"z".repeat(100)}&repo=ui&title=T`);
    renderBoard();
    const form = await openNewForm();
    expect(screen.getByText(`Unknown factory "${"z".repeat(40)}" in the link; pick one.`)).toBeInTheDocument();
    expect(within(form).getByLabelText("Factory")).toHaveValue("alpha");
    fireEvent.change(within(form).getByLabelText("Factory"), { target: { value: "delta" } });
    expect(screen.queryByText(/Unknown factory/)).not.toBeInTheDocument();
  });

  it("notes_a_repo_the_named_factory_does_not_have", async () => {
    resetFakeBoard(two());
    link("factory=delta&repo=web&title=T");
    renderBoard();
    const form = await openNewForm();
    expect(within(form).getByLabelText("Factory")).toHaveValue("delta");
    expect(within(form).getByLabelText("Repo")).toHaveValue("api");
    expect(screen.getByText('Unknown repo "web" in the link; pick one.')).toBeInTheDocument();
  });
});
