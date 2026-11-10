import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@factory/core";
import { clearAllUnsent, keepUnsent } from "../../lib/unsent";
import { factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { TopBarLeadContext, type Lead } from "../../app/topBarLead";
import { BoardView } from "./BoardView";
import { BOARD_VIEW_KEY, resetBoardViewForTests } from "./useBoardView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const ORDER = ["Inbox", "Ready", "Spec", "Spec review", "Plan", "Plan review", "Build", "Verify", "Review", "PR open", "Done", "Blocked", "Cancelled"];

function renderBoard() {
  const onNavigate = vi.fn();
  return { onNavigate, ...renderWithClient(<BoardView onNavigate={onNavigate} />) };
}

const column = (name: string) => screen.getByRole("region", { name });

/** The 13-column tests run in All stages; Lanes is the default. */
const showStages = () => window.localStorage.setItem(BOARD_VIEW_KEY, "stages");

beforeEach(() => {
  resetFakeBoard();
  resetBoardViewForTests();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  clearAllUnsent();
  vi.restoreAllMocks();
  resetBoardViewForTests();
});

describe("BoardView", () => {
  beforeEach(showStages);
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

  it("new_task_is_primary_only_while_the_form_is_closed", async () => {
    renderBoard();
    const open = await screen.findByRole("button", { name: "New task" });
    expect(open).toHaveClass("sf-button-primary");
    fireEvent.click(open);
    expect(screen.getByRole("button", { name: "New task" })).not.toHaveClass("sf-button-primary");
    expect(screen.getByRole("button", { name: "Create task" })).toHaveClass("sf-button-primary");
    expect(document.querySelector(".sf-button-accent")).toBeNull();
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
  beforeEach(showStages);
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
  beforeEach(showStages);
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
    await seedTask({ factoryId: "alpha", repo: "api", title: "Normal" });
    fakeBoard().ownerData.seed("FactoryTask", {
      attempt: 0, baseBranch: "dev", costUsd: 0, description: "", factoryId: "ghost", gateOverrides: "{}", repo: "x", status: "inbox",
      taskId: "T-90", title: "Orphan", version: 1
    });
    renderBoard();
    expect(await screen.findByText("Orphan")).toBeInTheDocument();
    expect(screen.getByText("ghost · T-90")).toBeInTheDocument();
    const names = within(screen.getByLabelText("Factory", { selector: "select" })).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["All factories", "Alpha", "Delta"]);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const form = await openNewForm();
    expect(within(within(form).getByLabelText("Factory")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Alpha", "Delta"]);
  });
});

const openNewForm = () => screen.findByRole("form", { name: "New task" });

describe("BoardView with a stored factory pick that is not usable", () => {
  beforeEach(showStages);
  it.each([["ghost"], ["GATE-gate"]])("falls_back_to_all_for_the_stored_pick_%s_and_renders_the_tasks", async (stored) => {
    resetFakeBoard(merge(two(), factory("GATE-gate", ["api"])));
    await seedTask({ factoryId: "alpha", repo: "api", title: "Alpha work" });
    await seedTask({ factoryId: "delta", repo: "api", title: "Delta work" });
    window.localStorage.setItem("factory-board:factory", stored);
    renderBoard();
    expect(await screen.findByText("Alpha work")).toBeInTheDocument();
    expect(screen.getByText("Delta work")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Factory", { selector: "select" })).toHaveValue("all"));
  });
});

describe("BoardView waiting strip", () => {
  beforeEach(showStages);
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
  beforeEach(showStages);
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

  it.each([" Main ", "origin/main", "refs/heads/main"])("refuses_main_as_the_base_inline (%j)", async (value) => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = await openNewForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "T" } });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("never uses main");
    expect(await fakeBoard().owner.listTasks()).toEqual([]);
  });
});

describe("BoardView new-task link with factories", () => {
  beforeEach(showStages);
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

describe("a New task link that is not used before the form closes", () => {
  beforeEach(showStages);
  it("is_dropped_when_the_form_closes_before_the_factories_load", async () => {
    resetFakeBoard(two());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = fakeBoard().owner.listFactoryDefs.bind(fakeBoard().owner);
    vi.spyOn(fakeBoard().owner, "listFactoryDefs").mockImplementation(async () => { await gate; return list(); });
    window.history.replaceState({}, "", "/?new=1&factory=delta&repo=ui");
    renderBoard();
    expect(await screen.findByText("Loading factories…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.queryByText("Loading factories…")).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByLabelText("Factory", { selector: "select" })).toContainHTML("Delta"));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const form = await openNewForm();
    expect(within(form).getByLabelText("Factory")).toHaveValue("alpha");
    expect(within(form).getByLabelText("Repo")).toHaveValue("api");
  });
});

describe("BoardView lanes", () => {
  const LANE_NAMES = ["Needs you", "Queued", "Working", "Done", "Stopped"];
  const lane = (name: string) => screen.getByRole("region", { name });
  const regionNames = () => screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
  const seedAll = async () => {
    await seedTask({ title: "Spec rev" }, "spec_review", { stage: "spec" });
    await seedTask({ title: "PR task" }, "pr_open");
    await seedTask({ title: "Stuck" }, "blocked");
    await seedTask({ title: "In inbox" });
    await seedTask({ title: "Is ready" }, "ready");
    await seedTask({ title: "Building" }, "build");
    await seedTask({ title: "Shipped" }, "done");
    await seedTask({ title: "Dropped" }, "cancelled");
  };

  it("opens_in_lanes_by_default_with_five_named_lanes", async () => {
    await seedTask({ title: "First" });
    renderBoard();
    await screen.findByText("First");
    expect(regionNames()).toEqual(LANE_NAMES);
  });

  it("places_tasks_in_the_lane_for_their_status", async () => {
    await seedAll();
    renderBoard();
    await within(await screen.findByRole("region", { name: "Needs you" })).findByText("Stuck");
    for (const title of ["Spec rev", "PR task", "Stuck"]) expect(within(lane("Needs you")).getByText(title)).toBeInTheDocument();
    for (const title of ["In inbox", "Is ready"]) expect(within(lane("Queued")).getByText(title)).toBeInTheDocument();
    expect(within(lane("Working")).getByText("Building")).toBeInTheDocument();
    expect(within(lane("Done")).getByText("Shipped")).toBeInTheDocument();
    expect(within(lane("Stopped")).getByText("Dropped")).toBeInTheDocument();
    expect(lane("Needs you").querySelector(".sf-count")).toHaveTextContent("3");
    expect(lane("Queued").querySelector(".sf-count")).toHaveTextContent("2");
  });

  it("a_task_created_from_the_form_lands_in_queued", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = screen.getByRole("form", { name: "New task" });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Fresh" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await within(lane("Queued")).findByText("Fresh")).toBeInTheDocument();
  });

  it("each_lane_shows_name_count_and_hint", async () => {
    await seedAll();
    renderBoard();
    await within(await screen.findByRole("region", { name: "Needs you" })).findByText("Stuck");
    const needs = lane("Needs you");
    expect(within(needs).getByText("Waiting for your review or answer")).toBeInTheDocument();
    const name = needs.querySelector("h3");
    expect(name).toHaveClass("sf-label");
    expect(name).toHaveTextContent("Needs you");
    expect(needs.querySelector(".sf-count")).toHaveTextContent("3");
  });

  it("an_empty_lane_still_shows_name_count_and_hint", async () => {
    await seedTask({ title: "Only one" });
    renderBoard();
    await screen.findByText("Only one");
    const stopped = lane("Stopped");
    expect(stopped.querySelector(".sf-count")).toHaveTextContent("0");
    expect(within(stopped).getByText("Cancelled tasks")).toBeInTheDocument();
    expect(stopped.querySelector("li")).toBeNull();
  });

  it("done_lane_lists_every_done_task_newest_first_and_is_not_collapsible", async () => {
    for (const title of ["D1", "D2", "D3"]) await seedTask({ title }, "done");
    renderBoard();
    await screen.findByText("D1");
    const titles = (region: HTMLElement) => within(region).getAllByRole("listitem").map((li) => li.textContent ?? "");
    const inLanes = titles(lane("Done"));
    expect(inLanes).toHaveLength(3);
    expect(within(lane("Done")).queryByRole("button", { expanded: false })).toBeNull();
    expect(lane("Done").querySelector("[aria-expanded]")).toBeNull();
    expect(lane("Stopped").querySelector("[aria-expanded]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All stages" }));
    fireEvent.click(screen.getByRole("button", { name: "Done (3)" }));
    const inColumn = titles(column("Done"));
    expect(inLanes.map((t) => D(t))).toEqual(inColumn.map((t) => D(t)));
  });

  it("shows_a_task_with_an_unknown_status_in_working", async () => {
    fakeBoard().ownerData.seed("FactoryTask", {
      attempt: 0, baseBranch: "dev", costUsd: 0, description: "", gateOverrides: "{}", repo: "data", status: "paused",
      taskId: "T-900", title: "Odd one", version: 1
    });
    renderBoard();
    expect(await within(await screen.findByRole("region", { name: "Working" })).findByText("Odd one")).toBeInTheDocument();
  });

  it("shows_loading_and_no_lanes_while_pending", () => {
    renderBoard();
    expect(screen.getByText("Loading tasks…")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("factory_repo_and_test_task_filters_apply_in_lanes", async () => {
    resetFakeBoard(two());
    await seedTask({ factoryId: "alpha", repo: "api", title: "Alpha work" });
    await seedTask({ factoryId: "alpha", repo: "web", title: "Alpha web" });
    await seedTask({ factoryId: "delta", repo: "api", title: "Delta work" });
    fakeBoard().ownerData.seed("FactoryTask", {
      attempt: 0, baseBranch: "dev", costUsd: 0, description: "", factoryId: "alpha", gateOverrides: "{}", repo: "api", status: "inbox",
      taskId: "GATE-1a2b3c4d", title: "Gate probe", version: 1
    });
    renderBoard();
    await screen.findByText("Alpha work");
    await pickFactory("delta");
    expect(screen.queryByText("Alpha work")).toBeNull();
    expect(within(lane("Queued")).getByText("Delta work")).toBeInTheDocument();
    await pickFactory("alpha");
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "web" } });
    expect(screen.queryByText("Alpha work")).toBeNull();
    expect(within(lane("Queued")).getByText("Alpha web")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "api" } });
    expect(screen.queryByText("Gate probe")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    expect(within(lane("Queued")).getByText("Gate probe")).toBeInTheDocument();
  });

  it("toolbar_has_a_lanes_all_stages_group_with_lanes_pressed_by_default", async () => {
    renderBoard();
    const group = await screen.findByRole("group", { name: "Board view" });
    expect(within(group).getByRole("button", { name: "Lanes" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "All stages" })).toHaveAttribute("aria-pressed", "false");
    expect(group.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  });

  it("clicking_all_stages_shows_the_13_columns_and_stores_stages", async () => {
    await seedTask({ title: "First" });
    renderBoard();
    await screen.findByText("First");
    fireEvent.click(screen.getByRole("button", { name: "All stages" }));
    expect(regionNames()).toEqual(ORDER);
    expect(window.localStorage.getItem("factory-board:view")).toBe("stages");
    expect(screen.getByRole("button", { name: "All stages" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Done (0)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Cancelled (0)" })).toHaveAttribute("aria-expanded", "false");
  });

  it("restores_the_stored_view_on_reload", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "All stages" }));
    cleanup();
    resetBoardViewForTests();
    renderBoard();
    await screen.findByRole("region", { name: "Inbox" });
    expect(screen.getByRole("button", { name: "All stages" })).toHaveAttribute("aria-pressed", "true");
  });

  it("garbage_stored_value_opens_lanes_without_error", async () => {
    window.localStorage.setItem(BOARD_VIEW_KEY, "garbage");
    renderBoard();
    expect(await screen.findByRole("region", { name: "Needs you" })).toBeInTheDocument();
  });

  it("a_throwing_storage_still_switches_views", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "All stages" }));
    expect(regionNames()).toEqual(ORDER);
  });

  it("switching_views_does_not_refetch_or_reset_state", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    const spy = vi.spyOn(fakeBoard().owner, "listTasks");
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "All stages" }));
    fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Show test tasks" })).toBeChecked();
    expect(screen.getByLabelText("Title")).toHaveValue("Draft");
  });

  it("switch_buttons_are_native_buttons", async () => {
    renderBoard();
    const group = await screen.findByRole("group", { name: "Board view" });
    for (const button of within(group).getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
    }
  });
});

/** A card's text without its volatile parts: the title is what orders the list. */
const D = (text: string) => /D\d/.exec(text)?.[0] ?? text;

const NEEDS_YOU_NAMES = ["Spec review", "Plan review", "PR open", "Blocked"];

describe("BoardView all stages restyle", () => {
  beforeEach(showStages);

  it("shows_one_hint_line_above_the_strip", async () => {
    await seedTask({ title: "First" });
    const { container } = renderBoard();
    const hint = await screen.findByText(/Every status as its own column\./);
    expect(hint.textContent).toContain("Every status as its own column. Outlined columns wait for you.");
    expect(hint.textContent).toContain("Scroll sideways for Review, PR open, Done, Blocked and Cancelled");
    expect(hint.tagName).toBe("P");
    expect(hint.nextElementSibling).toHaveClass("sf-columns");
    expect(container.querySelectorAll(".sf-columns")).toHaveLength(1);
    expect(container.querySelectorAll(".sf-columns > section")).toHaveLength(13);
  });

  it("marks_exactly_the_four_owner_columns_as_needs_you", async () => {
    await seedTask({ title: "First" });
    renderBoard();
    await screen.findByText("First");
    for (const name of ORDER) {
      if (NEEDS_YOU_NAMES.includes(name)) expect(column(name)).toHaveClass("sf-column-needs-you");
      else expect(column(name)).not.toHaveClass("sf-column-needs-you");
    }
  });

  it("shows_no_hint_or_strip_in_lanes", async () => {
    window.localStorage.removeItem(BOARD_VIEW_KEY);
    await seedTask({ title: "First" });
    const { container } = renderBoard();
    await screen.findByText("First");
    expect(screen.queryByText(/Every status as its own column/)).toBeNull();
    expect(container.querySelector(".sf-columns")).toBeNull();
  });

  it("shows_no_hint_or_strip_while_loading", () => {
    const { container } = renderBoard();
    expect(screen.getByText("Loading tasks…")).toHaveAttribute("role", "status");
    expect(screen.queryByText(/Every status as its own column/)).toBeNull();
    expect(container.querySelector(".sf-columns")).toBeNull();
  });

  it("shows_no_hint_or_strip_when_the_board_fails_to_load", async () => {
    vi.spyOn(fakeBoard().owner, "listTasks").mockRejectedValue(new Error("down"));
    const { container } = renderBoard();
    await screen.findByRole("alert");
    expect(screen.queryByText(/Every status as its own column/)).toBeNull();
    expect(container.querySelector(".sf-columns")).toBeNull();
  });

  it("an_empty_column_keeps_its_frame_and_zero_count", async () => {
    renderBoard();
    const plan = await screen.findByRole("region", { name: "Plan review" });
    expect(within(plan).getByText("0")).toHaveClass("sf-count");
    expect(screen.getAllByRole("region")).toHaveLength(13);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    expect(screen.getAllByRole("region")).toHaveLength(13);
  });

  it("done_and_cancelled_start_collapsed_with_counts_and_no_cards", async () => {
    await seedTask({ title: "Shipped" }, "done");
    await seedTask({ title: "Dropped" }, "cancelled");
    renderBoard();
    for (const name of ["Done (1)", "Cancelled (1)"]) {
      expect(await screen.findByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
    }
    expect(column("Done")).toHaveClass("sf-column-collapsed");
    expect(column("Cancelled")).toHaveClass("sf-column-collapsed");
    expect(screen.queryByText("Shipped")).toBeNull();
    expect(screen.queryByText("Dropped")).toBeNull();
  });

  it("clicking_the_header_expands_and_clicking_again_collapses", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    const toggle = await screen.findByRole("button", { name: "Done (1)" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(column("Done")).not.toHaveClass("sf-column-collapsed");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Shipped")).toBeNull();
    expect(column("Done")).toHaveClass("sf-column-collapsed");
  });

  it("a_collapsed_column_with_tasks_has_no_aria_controls", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    const toggle = await screen.findByRole("button", { name: "Done (1)" });
    expect(toggle).not.toHaveAttribute("aria-controls");
    fireEvent.click(toggle);
    const target = toggle.getAttribute("aria-controls");
    expect(target).toBeTruthy();
    expect(document.getElementById(target ?? "")).not.toBeNull();
  });

  it("expansion_is_not_remembered", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "Done (1)" }));
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    cleanup();
    renderBoard();
    expect(await screen.findByRole("button", { name: "Done (1)" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Done (1)" }));
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
    fireEvent.click(screen.getByRole("button", { name: "All stages" }));
    expect(screen.getByRole("button", { name: "Done (1)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Shipped")).toBeNull();
  });

  it("an_unknown_status_task_does_not_break_the_strip", async () => {
    fakeBoard().ownerData.seed("FactoryTask", {
      attempt: 0, baseBranch: "dev", costUsd: 0, description: "", gateOverrides: "{}", repo: "data", status: "paused",
      taskId: "T-900", title: "Odd one", version: 1
    });
    renderBoard();
    await screen.findByRole("region", { name: "Inbox" });
    expect(screen.getAllByRole("region")).toHaveLength(13);
  });
});

describe("New task form restyle and Mark ready now", () => {
  beforeEach(showStages);
  async function openForm() {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    return screen.getByRole("form", { name: "New task" });
  }
  const ready = (form: HTMLElement) => within(form).getByRole("switch", { name: "Mark ready now" });

  it("new_task_form_has_visible_28px_title_and_outlined_close", async () => {
    const form = await openForm();
    expect(within(form).getByRole("heading", { name: "New task" })).toHaveClass("sf-page-title");
    expect(within(form).getByRole("button", { name: "Close" })).not.toHaveClass("sf-button-primary");
  });

  it("mark_ready_now_is_a_shared_switch_off_by_default", async () => {
    const form = await openForm();
    expect(ready(form)).not.toBeChecked();
    expect(ready(form).closest("label")).toHaveClass("sf-switch");
  });

  it("switch_off_creates_only", async () => {
    const create = vi.spyOn(fakeBoard().owner, "createTask");
    const update = vi.spyOn(fakeBoard().owner, "updateTask");
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Plain" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await within(column("Inbox")).findByText("Plain");
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect((await fakeBoard().owner.listTasks())[0]!.status).toBe("inbox");
  });

  it("switch_on_creates_then_marks_ready", async () => {
    const create = vi.spyOn(fakeBoard().owner, "createTask");
    const update = vi.spyOn(fakeBoard().owner, "updateTask");
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Go now" } });
    fireEvent.click(ready(form));
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument());
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(update.mock.invocationCallOrder[0]!);
    const [stored] = await fakeBoard().owner.listTasks();
    expect(stored!.status).toBe("ready");
    expect((await fakeBoard().owner.listEvents(stored!.taskId)).length).toBe(2);
  });

  it("create_failure_never_marks_ready", async () => {
    const update = vi.spyOn(fakeBoard().owner, "updateTask");
    const create = vi.spyOn(fakeBoard().owner, "createTask");
    const form = await openForm();
    fireEvent.click(ready(form));
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("title must not be blank");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Keep" } });
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: "main" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByText(/never uses main as a base/)).toBeInTheDocument();
    create.mockRejectedValueOnce(new ForbiddenError("no"));
    fireEvent.change(within(form).getByLabelText("Base branch"), { target: { value: "dev" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Blocks refused this change for your account.")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(within(form).getByLabelText("Title")).toHaveValue("Keep");
  });

  it("mark_ready_failure_keeps_inbox_and_notifies_after_the_form_closes", async () => {
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new ForbiddenError("no"));
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Half" } });
    fireEvent.click(ready(form));
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument());
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("Blocks refused this change for your account.");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("The task was created but not marked ready.");
    const [stored] = await fakeBoard().owner.listTasks();
    expect(stored!.status).toBe("inbox");
    await within(column("Inbox")).findByText("Half");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.queryByText("The task was created but not marked ready.")).not.toBeInTheDocument();
  });

  it("submit_disabled_while_in_flight", async () => {
    let release: () => void = () => undefined;
    const real = fakeBoard().owner.createTask.bind(fakeBoard().owner);
    const create = vi.spyOn(fakeBoard().owner, "createTask").mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return real(...args);
    });
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Once" } });
    const button = within(form).getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(create).toHaveBeenCalledTimes(1);
    release();
    await within(column("Inbox")).findByText("Once");
  });

  it("ready_now_is_not_persisted_in_unsent", async () => {
    let form = await openForm();
    fireEvent.click(ready(form));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    form = screen.getByRole("form", { name: "New task" });
    expect(ready(form)).not.toBeChecked();
  });
});

describe("BoardView top bar Cancel", () => {
  function renderWithLead() {
    const leads: Array<Lead | null> = [];
    const setter = (lead: Lead | null) => void leads.push(lead);
    const view = renderWithClient(
      <TopBarLeadContext.Provider value={setter}>
        <BoardView onNavigate={vi.fn()} />
      </TopBarLeadContext.Provider>
    );
    return { leads, ...view };
  }
  const last = (leads: Array<Lead | null>) => leads[leads.length - 1];

  it("registers_Cancel_in_the_top_bar_while_the_New_task_form_is_open", async () => {
    const { leads } = renderWithLead();
    expect(last(leads)).toBeUndefined();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    expect(last(leads)?.label).toBe("Cancel");
  });

  it("the_Cancel_lead_closes_the_form_exactly_like_Close_and_keeps_the_unsent_draft", async () => {
    const { leads } = renderWithLead();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    fireEvent.change(within(screen.getByRole("form", { name: "New task" })).getByLabelText("Title"), { target: { value: "Half typed" } });
    act(() => last(leads)?.onClick());
    expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(within(screen.getByRole("form", { name: "New task" })).getByLabelText("Title")).toHaveValue("Half typed");
  });

  it("the_lead_is_cleared_when_the_form_closes_including_by_the_New_task_button", async () => {
    const { leads } = renderWithLead();
    const open = await screen.findByRole("button", { name: "New task" });
    fireEvent.click(open);
    expect(last(leads)?.label).toBe("Cancel");
    fireEvent.click(open);
    expect(screen.queryByRole("form", { name: "New task" })).not.toBeInTheDocument();
    expect(last(leads)).toBeNull();
  });
});

describe("BoardView lane pills", () => {
  const NAMES = ["Needs you", "Queued", "Working", "Done", "Stopped"];
  const group = () => screen.getByRole("group", { name: "Lane" });
  const pill = (name: string) => within(group()).getByRole("button", { name: new RegExp(`^${name}`) });
  const section = (name: string) => screen.getByRole("region", { name });
  const seedTwo = async () => {
    await seedTask({ title: "Spec rev" }, "spec_review", { stage: "spec" });
    await seedTask({ title: "PR task" }, "pr_open");
    await seedTask({ title: "Building" }, "build");
  };

  it("shows_lane_pills_in_order_with_counts_and_Needs_you_pressed_by_default", async () => {
    await seedTwo();
    renderBoard();
    await screen.findAllByText("Spec rev");
    const buttons = within(group()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Needs you 2", "Queued 0", "Working 1", "Done 0", "Stopped 0"]);
    expect(buttons.every((b) => b.classList.contains("sf-pill"))).toBe(true);
    expect(group()).toHaveClass("sf-pills");
    for (const name of NAMES) expect(pill(name)).toHaveAttribute("aria-pressed", name === "Needs you" ? "true" : "false");
  });

  it("clicking_Working_selects_it_deselects_Needs_you_and_flips_data_selected", async () => {
    await seedTwo();
    renderBoard();
    await screen.findAllByText("Spec rev");
    fireEvent.click(pill("Working"));
    expect(pill("Working")).toHaveAttribute("aria-pressed", "true");
    expect(pill("Needs you")).toHaveAttribute("aria-pressed", "false");
    expect(section("Working")).toHaveAttribute("data-selected", "true");
    expect(section("Needs you")).toHaveAttribute("data-selected", "false");
  });

  it("each_lane_section_has_data_selected_true_only_for_the_selected_lane", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    expect(NAMES.map((n) => section(n).getAttribute("data-selected"))).toEqual(["true", "false", "false", "false", "false"]);
  });

  it("switching_pills_does_not_call_listTasks_again", async () => {
    await seedTwo();
    const spy = vi.spyOn(fakeBoard().owner, "listTasks");
    renderBoard();
    await screen.findAllByText("Spec rev");
    const before = spy.mock.calls.length;
    for (const name of ["Working", "Done", "Needs you"]) fireEvent.click(pill(name));
    expect(spy.mock.calls.length).toBe(before);
  });

  it("All_stages_renders_no_pill_group", async () => {
    showStages();
    await seedTwo();
    renderBoard();
    await screen.findAllByText("Spec rev");
    expect(screen.queryByRole("group", { name: "Lane" })).not.toBeInTheDocument();
  });

  it("the_selected_lane_resets_to_Needs_you_on_remount_and_is_not_stored", async () => {
    await seedTwo();
    const first = renderBoard();
    await screen.findAllByText("Spec rev");
    const keys = Object.keys(window.localStorage).sort();
    fireEvent.click(pill("Done"));
    expect(Object.keys(window.localStorage).sort()).toEqual(keys);
    first.unmount();
    renderBoard();
    await screen.findAllByText("Spec rev");
    expect(pill("Needs you")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("BoardView empty lane text", () => {
  it("an_empty_selected_lane_shows_Nothing_in_Stopped", async () => {
    await seedTask({ title: "Spec rev" }, "spec_review", { stage: "spec" });
    renderBoard();
    await screen.findAllByText("Spec rev");
    fireEvent.click(screen.getByRole("button", { name: /^Stopped/ }));
    const text = within(screen.getByRole("region", { name: "Stopped" })).getByText("Nothing in Stopped.");
    expect(text).toHaveClass("sf-empty", "sf-lane-empty");
  });

  it("only_the_selected_lane_renders_the_empty_text", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    expect(screen.getAllByText(/^Nothing in /).map((e) => e.textContent)).toEqual(["Nothing in Needs you."]);
    fireEvent.click(screen.getByRole("button", { name: /^Working/ }));
    expect(screen.getAllByText(/^Nothing in /).map((e) => e.textContent)).toEqual(["Nothing in Working."]);
  });

  it("a_lane_with_tasks_renders_no_empty_text", async () => {
    await seedTask({ title: "Spec rev" }, "spec_review", { stage: "spec" });
    renderBoard();
    await screen.findAllByText("Spec rev");
    expect(screen.queryByText(/^Nothing in /)).not.toBeInTheDocument();
  });
});

describe("New task form action bar", () => {
  it("Create_task_sits_in_sf_action_bar_and_Close_is_in_the_same_bar", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = screen.getByRole("form", { name: "New task" });
    const bar = within(form).getByRole("button", { name: "Create task" }).parentElement;
    expect(bar).toHaveClass("sf-actions", "sf-action-bar");
    expect(bar).toContainElement(within(form).getByRole("button", { name: "Close" }));
  });

  it("Close_has_the_sf_action_close_class", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const form = screen.getByRole("form", { name: "New task" });
    expect(within(form).getByRole("button", { name: "Close" })).toHaveClass("sf-action-close");
  });
});
