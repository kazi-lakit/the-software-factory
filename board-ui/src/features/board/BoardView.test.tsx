import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllUnsent, keepUnsent } from "../../lib/unsent";
import { factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { BoardView } from "./BoardView";
import { BOARD_VIEW_KEY, resetBoardViewForTests } from "./useBoardView";
import { atPhoneWidth, BOARD_CSS, renderedClasses, tooWide } from "../../test/phoneWidth";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

/** Opens the Board at `/?query`, as a New task link does. */
const link = (query: string) => window.history.replaceState({}, "", `/?${query}`);

const ORDER = ["Inbox", "Ready", "Spec", "Spec review", "Plan", "Plan review", "Build", "Verify", "Review", "PR open", "Done", "Blocked", "Cancelled"];

function renderBoard() {
  const onNavigate = vi.fn();
  return { onNavigate, ...renderWithClient(<BoardView onNavigate={onNavigate} />) };
}

const column = (name: string) => screen.getByRole("region", { name });
/** The Show/Hide button of a collapsible All stages column (Done, Cancelled). */
const toggleOf = (name: string) => within(column(name)).getByRole("button", { name: /^(Show|Hide)$/ });
const findToggle = async (name: string) => {
  await screen.findByRole("region", { name });
  return toggleOf(name);
};

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
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    expect(screen.getByText("Gate probe")).toBeInTheDocument();
  });

  it("collapses_done_and_cancelled_with_their_counts", async () => {
    await seedTask({ title: "Shipped" }, "done");
    await seedTask({ title: "Dropped" }, "cancelled");
    renderBoard();
    const done = await findToggle("Done");
    expect(done).toHaveAttribute("aria-expanded", "false");
    expect(done).toHaveTextContent("Show");
    expect(toggleOf("Cancelled")).toHaveAttribute("aria-expanded", "false");
    expect(toggleOf("Cancelled")).toHaveTextContent("Show");
    expect(column("Done").querySelector(".sf-count")).toHaveTextContent("1");
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

  it("opens_a_task_from_its_card", async () => {
    const task = await seedTask({ title: "Open me" });
    const { onNavigate } = renderBoard();
    fireEvent.click(await screen.findByRole("link", { name: "Open me" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(`/tasks/${task.taskId}`));
  });

  it("new_task_is_a_primary_link_to_tasks_new", async () => {
    const { onNavigate } = renderBoard();
    const link = await screen.findByRole("link", { name: "New task" });
    expect(link).toHaveAttribute("href", "/tasks/new");
    expect(link).toHaveClass("sf-button", "sf-button-primary");
    expect(link).not.toHaveAttribute("aria-expanded");
    expect(link).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("/tasks/new");
    expect(screen.queryByRole("form", { name: "New task" })).toBeNull();
    expect(document.querySelector(".sf-button-accent")).toBeNull();
  });

  it("renders_no_new_task_form_even_with_unsent_draft", async () => {
    keepUnsent("new-task:title", "x");
    renderBoard();
    await screen.findByRole("region", { name: "Inbox" });
    expect(screen.queryByRole("form", { name: "New task" })).toBeNull();
  });

  it("forwards_a_new_task_link_to_tasks_new", async () => {
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    link("new=1&title=T&repo=iam");
    renderBoard();
    try {
      expect(window.location.pathname).toBe("/tasks/new");
      expect(window.location.search).toBe("?new=1&title=T&repo=iam");
      expect(popstate).toHaveBeenCalled();
      await screen.findByRole("link", { name: "New task" });
      expect(screen.queryByRole("form", { name: "New task" })).toBeNull();
      expect(await fakeBoard().owner.listTasks()).toEqual([]);
    } finally {
      window.removeEventListener("popstate", popstate);
    }
  });

  it("stays_on_the_board_without_new_1", async () => {
    link("new=0&title=T");
    renderBoard();
    await screen.findByRole("link", { name: "New task" });
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("form", { name: "New task" })).toBeNull();
    cleanup();
    link("title=T");
    renderBoard();
    await screen.findByRole("link", { name: "New task" });
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("form", { name: "New task" })).toBeNull();
  });

  it("points_aria_controls_only_at_a_rendered_list", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    const done = await findToggle("Done");
    const cancelled = toggleOf("Cancelled");
    expect(done).not.toHaveAttribute("aria-controls");
    fireEvent.click(done);
    const listId = done.getAttribute("aria-controls");
    expect(listId && document.getElementById(listId)).toBeTruthy();
    fireEvent.click(cancelled);
    expect(cancelled).not.toHaveAttribute("aria-controls");
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
  });
});

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

describe("BoardView Needs you lane order", () => {
  const needsYouTitles = () =>
    within(screen.getByRole("region", { name: "Needs you" })).getAllByRole("listitem").map((li) => /First|Second|Third/.exec(li.textContent ?? "")?.[0]);

  it("no_waiting_for_you_navigation_is_rendered", async () => {
    await seedTask({ title: "Stuck" }, "blocked", { question: "q" });
    renderBoard();
    await screen.findByText("Stuck");
    expect(screen.queryByRole("navigation", { name: "Waiting for you" })).toBeNull();
  });

  it("needs_you_lists_oldest_first_across_statuses", async () => {
    await seedTask({ title: "First" }, "blocked", { question: "q" });
    await seedTask({ title: "Second" }, "spec_review", { stage: "spec" });
    await seedTask({ title: "Third" }, "pr_open", { stage: "ship" });
    renderBoard();
    await screen.findByText("First");
    expect(needsYouTitles()).toEqual(["First", "Second", "Third"]);
  });

  it("needs_you_follows_the_picked_factory", async () => {
    resetFakeBoard(two());
    await seedTask({ factoryId: "alpha", repo: "api", title: "First" }, "blocked", { question: "q" });
    await seedTask({ factoryId: "delta", repo: "ui", title: "Second" }, "spec_review", { stage: "spec" });
    await seedTask({ factoryId: "alpha", repo: "web", title: "Third" }, "pr_open", { stage: "ship" });
    renderBoard();
    await screen.findByText("First");
    await pickFactory("alpha");
    expect(needsYouTitles()).toEqual(["First", "Third"]);
  });
});

describe("BoardView toolbar", () => {
  const search = () => screen.getByRole("searchbox", { name: "Search tasks by title or id" });
  const type = (value: string) => fireEvent.change(search(), { target: { value } });

  it("board_title_is_a_28px_page_title_h1", async () => {
    renderBoard();
    expect(await screen.findByRole("heading", { level: 1, name: "Board" })).toHaveClass("sf-page-title");
    expect(screen.queryByRole("heading", { level: 2, name: "Board" })).toBeNull();
  });

  it("search_field_is_named_and_has_the_placeholder", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    expect(search()).toHaveAttribute("placeholder", "Search tasks by title or id");
    expect(search()).toHaveClass("sf-input");
  });

  it("search_filters_lanes_by_title_case_insensitive", async () => {
    await seedTask({ title: "Add paging" });
    await seedTask({ title: "Fix login" });
    renderBoard();
    await screen.findByText("Add paging");
    const queued = () => screen.getByRole("region", { name: "Queued" });
    type("PAGING");
    expect(within(queued()).getByText("Add paging")).toBeInTheDocument();
    expect(within(queued()).queryByText("Fix login")).toBeNull();
    expect(queued().querySelector(".sf-count")).toHaveTextContent("1");
    type("");
    expect(within(queued()).getByText("Add paging")).toBeInTheDocument();
    expect(within(queued()).getByText("Fix login")).toBeInTheDocument();
  });

  it("search_filters_lanes_by_id_lower_case", async () => {
    const first = await seedTask({ title: "Alpha one" });
    await seedTask({ title: "Beta two" });
    renderBoard();
    await screen.findByText("Alpha one");
    type(first.taskId.toLowerCase());
    expect(screen.getByText("Alpha one")).toBeInTheDocument();
    expect(screen.queryByText("Beta two")).toBeNull();
  });

  it("search_filters_all_stages_columns_by_title_and_id", async () => {
    showStages();
    await seedTask({ title: "Alpha" });
    const beta = await seedTask({ title: "Beta" }, "spec_review", { stage: "spec" });
    renderBoard();
    await screen.findByText("Alpha");
    type("alpha");
    expect(within(column("Inbox")).getByText("Alpha")).toBeInTheDocument();
    expect(within(column("Spec review")).queryByText("Beta")).toBeNull();
    type(beta.taskId.toLowerCase());
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(within(column("Spec review")).getByText("Beta")).toBeInTheDocument();
  });

  it("search_is_not_persisted", async () => {
    const first = renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    type("something");
    first.unmount();
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    expect(search()).toHaveValue("");
  });

  it("board_view_switch_has_a_view_label", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    const groups = screen.getAllByRole("group", { name: "Board view" });
    expect(groups).toHaveLength(1);
    const wrap = groups[0]!.parentElement!;
    expect(wrap).toHaveClass("sf-board-view");
    const label = wrap.querySelector("span.sf-label.sf-board-view-label");
    expect(label).toHaveTextContent(/^View$/);
    expect(within(groups[0]!).getAllByRole("button").map((b) => b.textContent)).toEqual(["Lanes", "All stages"]);
  });
});

describe("BoardView at 360px", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = atPhoneWidth();
  });
  afterEach(() => restore());

  it("board_fits_360_with_phone_markup", async () => {
    await seedTask({ title: "Stuck" }, "blocked", { question: "Which base?\nA. dev: x (recommended)\nB. stg: y" });
    const { container } = renderBoard();
    await screen.findByText("Stuck");
    expect(tooWide(BOARD_CSS, renderedClasses(container, BOARD_CSS))).toEqual([]);
    expect(container.querySelector(".sf-board-view-label")).toHaveTextContent("View");
    expect(screen.getByRole("group", { name: "Board view" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Lane" })).toBeInTheDocument();
    expect(screen.getByText("Oldest first. Tap a task to act on it.")).toBeInTheDocument();
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
    fireEvent.click(within(lane("Stopped")).getByRole("button", { name: "Show" }));
    expect(within(lane("Stopped")).getByText("Dropped")).toBeInTheDocument();
    expect(lane("Needs you").querySelector(".sf-count")).toHaveTextContent("3");
    expect(lane("Queued").querySelector(".sf-count")).toHaveTextContent("2");
  });

  it("each_lane_shows_name_count_and_hint", async () => {
    await seedAll();
    renderBoard();
    await within(await screen.findByRole("region", { name: "Needs you" })).findByText("Stuck");
    const needs = lane("Needs you");
    expect(within(needs).getByText("Oldest first. Tap a task to act on it.")).toBeInTheDocument();
    const name = needs.querySelector(".sf-lane-name");
    expect(name?.tagName).toBe("SPAN");
    expect(name).toHaveClass("sf-label");
    expect(name).toHaveTextContent("Needs you");
    expect(needs.querySelector("h3")).toBeNull();
    expect(needs.querySelector(".sf-count")).toHaveTextContent("3");
  });

  it("working_lane_has_no_hint", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Working" });
    expect(lane("Working").querySelector(".sf-lane-hint")).toBeNull();
  });

  it("an_empty_lane_still_shows_name_count_and_hint", async () => {
    await seedTask({ title: "Only one" });
    renderBoard();
    await screen.findByText("Only one");
    const stopped = lane("Stopped");
    expect(stopped.querySelector(".sf-count")).toHaveTextContent("0");
    expect(within(stopped).getByText("Cancelled tasks. Kept for history.")).toBeInTheDocument();
    expect(stopped.querySelector("li")).toBeNull();
  });

  it("done_lane_shows_the_two_most_recent_and_a_history_link", async () => {
    for (const title of ["D1", "D2", "D3", "D4"]) await seedTask({ title }, "done");
    const { onNavigate } = renderBoard();
    await screen.findByText("D4");
    const done = lane("Done");
    expect(within(done).getAllByRole("listitem").map((li) => D(li.textContent ?? ""))).toEqual(["D4", "D3"]);
    expect(done.querySelector(".sf-count")).toHaveTextContent("4");
    const more = within(done).getByRole("link", { name: "Show all 4 in History" });
    expect(more).toHaveAttribute("href", "/history");
    fireEvent.click(more);
    expect(onNavigate).toHaveBeenCalledWith("/history");
    expect(done.querySelector("[aria-expanded]")).toBeNull();
  });

  it("done_lane_with_no_tasks_has_no_history_link", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Done" });
    expect(within(lane("Done")).queryByRole("link", { name: /in History/ })).toBeNull();
  });

  it("stopped_lane_starts_collapsed_and_show_lists_the_cards", async () => {
    await seedTask({ title: "Dropped" }, "cancelled");
    renderBoard();
    await screen.findByRole("region", { name: "Stopped" });
    await waitFor(() => expect(lane("Stopped").querySelector(".sf-count")).toHaveTextContent("1"));
    const stopped = lane("Stopped");
    expect(stopped.querySelector("li")).toBeNull();
    expect(stopped.querySelector(".sf-lane-name")).toHaveTextContent("Stopped");
    const toggle = within(stopped).getByRole("button", { name: "Show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    fireEvent.click(toggle);
    expect(within(stopped).getByText("Dropped")).toBeInTheDocument();
    expect(toggle).toHaveTextContent("Hide");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const target = toggle.getAttribute("aria-controls");
    expect(target && document.getElementById(target)).toBeTruthy();
    fireEvent.click(toggle);
    expect(within(stopped).queryByText("Dropped")).toBeNull();
  });

  it("selecting_the_Stopped_pill_lists_the_cancelled_cards", async () => {
    await seedTask({ title: "Dropped" }, "cancelled");
    renderBoard();
    await screen.findByRole("region", { name: "Stopped" });
    await waitFor(() => expect(lane("Stopped").querySelector(".sf-count")).toHaveTextContent("1"));
    fireEvent.click(within(screen.getByRole("group", { name: "Lane" })).getByRole("button", { name: /^Stopped/ }));
    expect(within(lane("Stopped")).getByText("Dropped")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
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
    expect(toggleOf("Done")).toHaveAttribute("aria-expanded", "false");
    expect(toggleOf("Cancelled")).toHaveAttribute("aria-expanded", "false");
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
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "All stages" }));
    fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Show test tasks" })).toBeChecked();
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

  it("shows_a_two_part_hint_row_above_the_columns", async () => {
    await seedTask({ title: "First" });
    const { container } = renderBoard();
    await screen.findByText("First");
    const hint = container.querySelector(".sf-columns-hint");
    expect(hint).not.toBeNull();
    expect([...hint!.children].map((c) => c.textContent)).toEqual([
      "Every status as its own column. Outlined columns wait for you.",
      "Scroll sideways for Review, PR open, Done, Blocked and Cancelled"
    ]);
    expect(hint!.nextElementSibling).toHaveClass("sf-columns");
    expect(container.querySelectorAll(".sf-columns")).toHaveLength(1);
    expect(container.querySelectorAll(".sf-columns > section")).toHaveLength(13);
  });

  it("empty_columns_say_nothing_here_or_nothing_waiting", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Inbox" });
    expect(within(column("Inbox")).getByText("Nothing here")).toBeInTheDocument();
    for (const name of NEEDS_YOU_NAMES) expect(within(column(name)).getByText("Nothing waiting")).toBeInTheDocument();
    expect(within(column("Done")).queryByText(/Nothing/)).toBeNull();
    fireEvent.click(toggleOf("Done"));
    expect(within(column("Done")).getByText("Nothing here")).toBeInTheDocument();
  });

  it("column_names_use_the_lane_name_style", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Inbox" });
    for (const name of ORDER) {
      const label = column(name).querySelector(".sf-lane-name");
      expect(label?.tagName).toBe("SPAN");
      expect(label).toHaveClass("sf-label");
      expect(label).toHaveTextContent(name);
    }
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

  it("marks_the_view_root_with_sf_view_stages_in_all_stages", async () => {
    await seedTask({ title: "First" });
    const { container } = renderBoard();
    await screen.findByText("First");
    expect(container.querySelector(".sf-view")).toHaveClass("sf-view-stages");
    expect(container.querySelectorAll(".sf-view-stages")).toHaveLength(1);
  });

  it("drops_sf_view_stages_in_lanes", async () => {
    await seedTask({ title: "First" });
    const { container } = renderBoard();
    await screen.findByText("First");
    fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
    expect(container.querySelector(".sf-view")).toHaveClass("sf-view");
    expect(container.querySelector(".sf-view")).not.toHaveClass("sf-view-stages");
    expect(container.querySelector(".sf-view-stages")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All stages" }));
    expect(container.querySelector(".sf-view")).toHaveClass("sf-view-stages");
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
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    expect(screen.getAllByRole("region")).toHaveLength(13);
  });

  it("done_and_cancelled_start_collapsed_with_counts_and_no_cards", async () => {
    await seedTask({ title: "Shipped" }, "done");
    await seedTask({ title: "Dropped" }, "cancelled");
    renderBoard();
    for (const name of ["Done", "Cancelled"]) {
      expect(await findToggle(name)).toHaveAttribute("aria-expanded", "false");
      expect(column(name).querySelector(".sf-count")).toHaveTextContent("1");
    }
    expect(column("Done")).toHaveClass("sf-column-collapsed");
    expect(column("Cancelled")).toHaveClass("sf-column-collapsed");
    expect(screen.queryByText("Shipped")).toBeNull();
    expect(screen.queryByText("Dropped")).toBeNull();
  });

  it("show_expands_and_hide_collapses", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    const toggle = await findToggle("Done");
    expect(toggle).toHaveTextContent("Show");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide");
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(column("Done")).not.toHaveClass("sf-column-collapsed");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Show");
    expect(screen.queryByText("Shipped")).toBeNull();
    expect(column("Done")).toHaveClass("sf-column-collapsed");
  });

  it("a_collapsed_column_with_tasks_has_no_aria_controls", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    const toggle = await findToggle("Done");
    expect(toggle).not.toHaveAttribute("aria-controls");
    fireEvent.click(toggle);
    const target = toggle.getAttribute("aria-controls");
    expect(target).toBeTruthy();
    expect(document.getElementById(target ?? "")).not.toBeNull();
  });

  it("expansion_is_not_remembered", async () => {
    await seedTask({ title: "Shipped" }, "done");
    renderBoard();
    fireEvent.click(await findToggle("Done"));
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    cleanup();
    renderBoard();
    expect(await findToggle("Done")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggleOf("Done"));
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
    fireEvent.click(screen.getByRole("button", { name: "All stages" }));
    expect(toggleOf("Done")).toHaveAttribute("aria-expanded", "false");
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

describe("BoardView dependencies", () => {
  it("shows_a_waiting_badge_on_a_ready_task_whose_dependency_is_unfinished", async () => {
    const { core, owner } = fakeBoard();
    const dep = await seedTask({ title: "Dep" });
    const t = await owner.createTask({ dependsOn: [dep.taskId], description: "", factoryId: "blocks", repo: "data", title: "Waiter" });
    await core.updateTask(t.taskId, t.version, { status: "ready" });
    renderBoard();
    const link = await screen.findByRole("link", { name: dep.taskId });
    expect(link).toHaveAttribute("href", `/tasks/${dep.taskId}`);
    expect(link.closest(".sf-card-waiting")).toHaveTextContent(`Waiting on ${dep.taskId}`);
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

  it("empty_lanes_have_explanatory_text_on_desktop", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    expect(screen.getAllByText(/^Nothing in /)).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: /^Working/ }));
    expect(screen.getByText("Nothing in Working.")).toHaveClass("sf-lane-empty-selected");
  });

  it("a_lane_with_tasks_renders_no_empty_text", async () => {
    await seedTask({ title: "Spec rev" }, "spec_review", { stage: "spec" });
    renderBoard();
    await screen.findAllByText("Spec rev");
    expect(within(screen.getByRole("region", { name: "Needs you" })).queryByText(/^Nothing in /)).not.toBeInTheDocument();
  });
});

describe("Board workspace redesign", () => {
  it("summarises the filtered queue and resets a search with no matches", async () => {
    await seedTask({ title: "Review invitations" }, "spec_review");
    await seedTask({ title: "Build exports" }, "build");
    renderBoard();
    await screen.findByText("Review invitations");
    const summary = screen.getByRole("group", { name: "Queue summary" });
    expect(summary).toHaveTextContent("Needs you1");
    expect(summary).toHaveTextContent("Working1");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks by title or id" }), { target: { value: "no-such-task" } });
    expect(screen.getByText("No tasks match your filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Review invitations")).toBeInTheDocument();
  });
});

describe("Board mobile filters", () => {
  it("exposes and collapses additional filters without clearing their values", async () => {
    renderBoard();
    await screen.findByRole("region", { name: "Needs you" });
    const toggle = screen.getByRole("button", { name: "Filters" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const repo = screen.getByRole("combobox", { name: "Repo" });
    fireEvent.change(repo, { target: { value: "blocks/data" } });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(repo).toHaveValue("blocks/data");
  });
});

it("keeps the result count in the toolbar and resets active filters", async () => {
  await seedTask({ title: "Searchable work" });
  const { container } = renderBoard();
  await screen.findByText("Searchable work");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Searchable" } });
  expect(container.querySelector(".sf-board-filters")).toContainElement(screen.getByText("1 task in view"));
  fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  expect(screen.getByRole("searchbox")).toHaveValue("");
});
