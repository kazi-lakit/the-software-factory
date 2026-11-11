import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { blocksFactories, factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
import { atPhoneWidth, BOARD_CSS, renderedClasses, tooWide } from "../../test/phoneWidth";
import { HistoryView } from "./HistoryView";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

/** A task row with no create event, so the only events are the ones a test adds. */
function seedTaskRow(taskId: string, title = `Task ${taskId}`) {
  fakeBoard().ownerData.seed("FactoryTask", {
    attempt: 0, baseBranch: "dev", costUsd: 0, description: "", gateOverrides: "{}", repo: "data", status: "inbox", taskId, title, version: 1
  });
}

function event(taskId: string, actor: string, field: string, at: string, from: string | null = "a", to = "b"): FactoryEvent {
  return { action: "set", actor, at, factoryId: "blocks", field, from, reason: `${field} by ${actor.split(" · ")[0]}`, taskId, to };
}

async function addEvents(...events: FactoryEvent[]) {
  await fakeBoard().core.addEvents(events);
}

function renderHistory() {
  const onNavigate = vi.fn();
  return { onNavigate, ...renderWithClient(<HistoryView onNavigate={onNavigate} />) };
}

function rows(): HTMLElement[] {
  const table = screen.getByRole("table", { name: "History" });
  return within(table).getAllByRole("row").slice(1);
}

/** The field of every row, top to bottom, read from the Why cell (the `event()` reason is `<field> by <actor>`). */
function fields(): string[] {
  return rows().map((row) => (within(row).getAllByRole("cell")[4]!.textContent ?? "").split(" by ")[0]!);
}

/** The Change cell of every row, top to bottom. */
function changes(): string[] {
  return rows().map((row) => within(row).getAllByRole("cell")[3]!.textContent ?? "");
}

const optionTexts = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);

// Noon UTC: the same local date in every time zone the tests may run in.
const DAY1 = "2026-11-01T12:00:00.000Z";
const DAY2 = "2026-11-02T12:00:00.000Z";
const DAY3 = "2026-11-03T12:00:00.000Z";

beforeEach(() => {
  resetFakeBoard();
  // DAY1 to DAY3 sit inside the default Last 7 days.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 3, 15, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HistoryView", () => {
  it("merges_events_from_several_tasks_and_the_settings_newest_first", async () => {
    seedTaskRow("T-1");
    seedTaskRow("T-2");
    await addEvents(
      event("T-1", "you", "status", DAY1),
      event("T-1", "spec-writer · sdk · run R1", "stage", DAY3),
      event("T-2", "core · loop", "branch", DAY2),
      event("-", "you", "settings.global.maxParallel", "2026-11-02T13:00:00.000Z", "2", "3")
    );
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    expect(fields()).toEqual(["stage", "settings.global.maxParallel", "branch", "status"]);
  });

  it("change_type_pills_filter_and_one_is_pressed", async () => {
    seedTaskRow("T-1");
    const qaEvent = (field: string, reason: string, at: string, to: string) => ({ ...event("T-1", "you", field, at, null, to), reason });
    await addEvents(
      { ...event("T-1", "core · loop", "status", DAY1, "spec", "spec_review"), action: "move" },
      qaEvent("question", "asked", DAY1, "Which?"),
      qaEvent("answer", "answered", DAY2, "A"),
      qaEvent("answer", "spec changes requested", DAY3, "fix"),
      event("-", "you", "settings.global.paused", "2026-11-03T13:00:00.000Z", "false", "true")
    );
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    await waitFor(() => expect(fields()).toHaveLength(5));

    const group = screen.getByRole("group", { name: "Change type" });
    const pills = within(group).getAllByRole("button");
    expect(pills.map((p) => p.textContent)).toEqual(["All changes", "Your decisions", "Questions and answers", "Status moves", "Settings"]);
    for (const pill of pills) expect(pill).toHaveClass("sf-history-pill");
    const pressed = () => pills.filter((p) => p.getAttribute("aria-pressed") === "true").map((p) => p.textContent);
    expect(pressed()).toEqual(["All changes"]);

    fireEvent.click(within(group).getByRole("button", { name: "Questions and answers" }));
    // These events carry their own reasons, which the Why cell shows.
    expect(fields()).toEqual(["answered", "asked"]);
    expect(changes()).toEqual(['Answered "Which?" with A', 'Asked: "Which?"']);
    expect(pressed()).toEqual(["Questions and answers"]);

    fireEvent.click(within(group).getByRole("button", { name: "Status moves" }));
    expect(fields()).toEqual(["status"]);
    fireEvent.click(within(group).getByRole("button", { name: "Your decisions" }));
    expect(fields()).toEqual(["settings.global.paused", "spec changes requested", "answered", "asked"]);
    fireEvent.click(within(group).getByRole("button", { name: "Settings" }));
    expect(fields()).toEqual(["settings.global.paused"]);
    expect(pressed()).toEqual(["Settings"]);
  });

  it("reads_events_per_task_and_never_the_whole_list", async () => {
    seedTaskRow("T-1");
    seedTaskRow("T-2");
    await addEvents(event("T-1", "you", "status", DAY1));
    const listEvents = vi.spyOn(fakeBoard().owner, "listEvents");
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    const asked = listEvents.mock.calls.map((call) => call[0]);
    expect(asked).not.toContain(undefined);
    expect(new Set(asked)).toEqual(new Set(["T-1", "T-2", "-"]));
  });

  it("shows_when_who_task_change_and_why", async () => {
    seedTaskRow("T-7");
    seedTaskRow("T-8");
    const long = "x".repeat(200);
    const at = new Date(2026, 10, 3, 10, 42).toISOString();
    await addEvents(
      event("T-7", "implementer · session · run R9", "branch", at, null, long),
      event("T-8", "spec-writer · session · run R1", "title", DAY1),
      event("T-8", "core · loop", "stage", DAY2),
      event("-", "you", "settings.iam.gates", DAY2, '{"pr":false}', "inherit")
    );
    const { onNavigate } = renderHistory();
    const table = await screen.findByRole("table", { name: "History" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["When", "Who", "Task", "Change", "Why"]);

    await waitFor(() => expect(rows()).toHaveLength(4));
    const row = (text: string) => rows().find((r) => r.textContent!.includes(text))!;
    const taskRow = row("T-7");
    const settingsRow = row("gates set to inherit");
    const coreRow = row("stage by core");
    const specRow = row("title by spec-writer");
    const time = taskRow.querySelector("time")!;
    expect(time).toHaveTextContent("Today 10:42");
    expect(time).toHaveAttribute("dateTime", at);
    expect(time.getAttribute("title")).toBeTruthy();

    const who = (r: HTMLElement) => within(r).getAllByRole("cell")[1]!;
    expect(who(taskRow).textContent).toBe("implementer · session");
    expect(who(taskRow).querySelector("span.sf-muted")?.textContent).toBe(" · session");
    expect(who(specRow).textContent).toBe("spec writer · session");
    expect(who(settingsRow).textContent).toBe("you");
    expect(who(coreRow).textContent).toBe("core · loop");

    const why = within(taskRow).getAllByRole("cell")[4]!;
    expect(why).toHaveClass("sf-muted");
    expect(why).toHaveTextContent("branch by implementer");

    expect(within(settingsRow).getByText("Settings")).toBeInTheDocument();
    expect(within(settingsRow).queryByRole("link")).not.toBeInTheDocument();

    const link = within(taskRow).getByRole("link", { name: "T-7" });
    expect(link).toHaveAttribute("href", "/tasks/T-7");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("/tasks/T-7");
    const change = within(taskRow).getAllByRole("cell")[3]!;
    expect(change).toHaveAttribute("title", `branch: — → ${long}`);
    expect(change.textContent!.length).toBeLessThan(120);
  });

  it("change_cell_renders_status_chips", async () => {
    seedTaskRow("T-1");
    await addEvents({ ...event("T-1", "core · loop", "status", DAY1, "spec", "spec_review"), action: "move", reason: "moved" });
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    const cell = within(rows()[0]!).getAllByRole("cell")[3]!;
    expect(cell.textContent).toBe("status spec → Spec review");
    expect(cell.querySelector(".sf-chip")?.textContent).toBe("Spec review");
  });

  it("change_cell_shows_doc_versions_from_task_history", async () => {
    seedTaskRow("T-1");
    const written = (at: string): FactoryEvent => ({
      ...event("T-1", "core · loop", "status", at, "spec", "spec_review"), action: "move", reason: "spec written, awaiting review"
    });
    await addEvents(written(DAY1), written(DAY2));
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    expect(changes()).toEqual(["Spec v2 written", "Spec v1 written"]);
  });

  it("search_filters_by_id_title_change_and_reason", async () => {
    seedTaskRow("T-1", "Fix login");
    seedTaskRow("T-2", "Other");
    await addEvents(
      event("T-1", "you", "branch", DAY1),
      event("T-2", "you", "dependsOn", DAY2, "[]", '["T-9"]'),
      { ...event("T-2", "you", "stage", DAY3), reason: "Rebased Today" }
    );
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const search = screen.getByRole("searchbox", { name: "Search history" });

    fireEvent.change(search, { target: { value: "t-1" } });
    expect(fields()).toEqual(["branch"]);
    fireEvent.change(search, { target: { value: "LOGIN" } });
    expect(fields()).toEqual(["branch"]);
    fireEvent.change(search, { target: { value: "waits for t-9" } });
    expect(fields()).toEqual(["dependsOn"]);
    fireEvent.change(search, { target: { value: "rebased today" } });
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getAllByRole("cell")[4]).toHaveTextContent("Rebased Today");
  });

  it("who_dropdown_offers_the_roles_and_filters_by_actor", async () => {
    seedTaskRow("T-1");
    seedTaskRow("T-2");
    await addEvents(
      event("T-1", "you", "title", DAY1),
      event("T-1", "spec-writer · sdk · run R1", "stage", DAY2),
      event("T-2", "core · loop", "branch", DAY2),
      event("T-2", "reviewer · loop · run R2", "status", DAY3),
      event("-", "you", "settings.global.paused", DAY3, "false", "true")
    );
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    await waitFor(() => expect(fields()).toHaveLength(5));
    const who = screen.getByLabelText("Who");
    expect(optionTexts(who)).toEqual(["Everyone", "You", "Spec writer", "Planner", "Implementer", "Verifier", "Reviewer", "Core"]);

    fireEvent.change(who, { target: { value: "core" } });
    expect(fields()).toEqual(["branch"]);
    fireEvent.change(who, { target: { value: "you" } });
    expect(fields()).toEqual(["settings.global.paused", "title"]);
    fireEvent.change(who, { target: { value: "all" } });

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "-" } });
    expect(fields()).toEqual(["settings.global.paused"]);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "T-1" } });
    expect(fields()).toEqual(["stage", "title"]);
  });

  it("task_dropdown_offers_all_tasks_ids_then_settings", async () => {
    seedTaskRow("T-2");
    seedTaskRow("T-10");
    renderHistory();
    const select = await screen.findByLabelText("Task");
    await waitFor(() => expect(optionTexts(select)).toEqual(["All tasks", "T-2", "T-10", "Settings"]));
  });

  it("when_dropdown_defaults_to_last_7_days_and_filters_by_local_date", async () => {
    seedTaskRow("T-1");
    await addEvents(
      event("T-1", "you", "now", new Date(2026, 10, 3, 10, 0).toISOString()),
      event("T-1", "you", "four", new Date(2026, 9, 30, 10, 0).toISOString()),
      event("T-1", "you", "fourteen", new Date(2026, 9, 20, 10, 0).toISOString())
    );
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    const when = screen.getByLabelText("When") as HTMLSelectElement;
    expect(optionTexts(when)).toEqual(["Last 7 days", "Today", "Last 30 days", "All time"]);
    expect(when.value).toBe("7d");
    expect(rows()).toHaveLength(2);
    fireEvent.change(when, { target: { value: "today" } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(when, { target: { value: "30d" } });
    expect(rows()).toHaveLength(3);
    fireEvent.change(when, { target: { value: "all" } });
    expect(rows()).toHaveLength(3);
  });

  it("factory_picker_shows_only_with_more_than_one_factory", async () => {
    seedTaskRow("T-1");
    await addEvents(event("T-1", "you", "title", DAY1));
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    expect(screen.queryByLabelText("Factory", { selector: "select" })).toBeNull();
  });

  it("show_test_tasks_shows_only_when_test_tasks_exist", async () => {
    seedTaskRow("T-1");
    await addEvents(event("T-1", "you", "title", DAY1));
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    expect(screen.queryByRole("checkbox", { name: "Show test tasks" })).toBeNull();
  });

  it("says_so_when_the_filters_match_nothing", async () => {
    seedTaskRow("T-1");
    await addEvents(event("T-1", "you", "title", DAY1));
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    fireEvent.change(screen.getByLabelText("Who"), { target: { value: "verifier" } });
    expect(screen.getByText("No events match these filters.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "History" })).not.toBeInTheDocument();
  });

  it("hides_gate_test_tasks_until_show_test_tasks_is_ticked", async () => {
    seedTaskRow("T-1");
    seedTaskRow("GATE-1a2b3c4d");
    await addEvents(event("T-1", "you", "title", DAY1), event("GATE-1a2b3c4d", "you", "probe", DAY2));
    const listEvents = vi.spyOn(fakeBoard().owner, "listEvents");
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    expect(fields()).toEqual(["title"]);
    expect(listEvents.mock.calls.map((call) => call[0])).not.toContain("GATE-1a2b3c4d");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show test tasks" }));
    await waitFor(() => expect(fields()).toEqual(["probe", "title"]));
  });

  it("shows_200_rows_then_more_on_request", async () => {
    seedTaskRow("T-1");
    const many = Array.from({ length: 250 }, (_, i) => event("T-1", "you", `f${i}`, new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString()));
    await addEvents(...many);
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    expect(fields()).toHaveLength(200);
    expect(fields()[0]).toBe("f249");
    expect(screen.getByText("Showing 200 of 250 changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(fields()).toHaveLength(250);
    expect(screen.getByText("Showing 250 of 250 changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("changing_a_filter_resets_paging", async () => {
    seedTaskRow("T-1");
    const many = Array.from({ length: 250 }, (_, i) => event("T-1", "you", `f${i}`, new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString()));
    await addEvents(...many);
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(fields()).toHaveLength(250);
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "all" } });
    expect(fields()).toHaveLength(200);
    expect(screen.getByText("Showing 200 of 250 changes")).toBeInTheDocument();
  });

  it("offers_a_retry_when_the_history_cannot_be_loaded", async () => {
    seedTaskRow("T-1");
    const listTasks = vi.spyOn(fakeBoard().owner, "listTasks").mockRejectedValueOnce(new Error("blocks: unavailable"));
    renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText("No history yet.");
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
});

describe("HistoryView factory filter", () => {
  const forFactory = (factoryId: string, field: string, at: string, from: string | null, to: string): FactoryEvent => ({
    action: "set", actor: "you", at, factoryId, field, from, reason: "saved", taskId: "-", to
  });

  beforeEach(() => {
    resetFakeBoard(merge(blocksFactories(), factory("delta", ["api"], { name: "Delta" })));
  });

  it("filtering_by_delta_hides_blocks_events", async () => {
    await addEvents(
      forFactory("blocks", "settings.blocks.maxParallel", DAY1, "2", "3"),
      forFactory("delta", "def.name", DAY2, "Delta", "Delta Two"),
      forFactory("delta", "repo.api.checks", DAY3, '{"a":1}', '{"a":2}')
    );
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    expect(changes()).toEqual(['checks set to {"a":2}', "name set to Delta Two", "maxParallel set to 3"]);
    const picker = screen.getByLabelText("Factory", { selector: "select" });
    await waitFor(() => expect(picker.querySelector('option[value="delta"]')).not.toBeNull());
    fireEvent.change(picker, { target: { value: "delta" } });
    expect(changes()).toEqual(['checks set to {"a":2}', "name set to Delta Two"]);
    fireEvent.change(picker, { target: { value: "blocks" } });
    expect(changes()).toEqual(["maxParallel set to 3"]);
    fireEvent.change(picker, { target: { value: "all" } });
    expect(changes()).toHaveLength(3);
  });

  it("shows_a_definition_events_field_old_and_new_values", async () => {
    await addEvents(forFactory("delta", "def.name", DAY1, "Delta", "Delta Two"));
    renderHistory();
    const row = (await screen.findByText("name set to Delta Two", { exact: false })).closest("tr")!;
    expect(within(row).getByText("Factory")).toBeInTheDocument();
  });
});

describe("HistoryView restyle", () => {
  it("history_renders_an_h1_above_the_toolbar", async () => {
    renderHistory();
    const heading = await screen.findByRole("heading", { level: 1, name: "History" });
    expect(heading).toHaveClass("sf-page-title");
    const search = screen.getByRole("searchbox", { name: "Search history" });
    expect(heading.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("history_table_sits_in_wrap", async () => {
    seedTaskRow("T-1");
    await addEvents(event("T-1", "you", "status", DAY1));
    renderHistory();
    const table = await screen.findByRole("table", { name: "History" });
    expect(table.closest(".sf-table-wrap")).not.toBeNull();
  });

  it("history_loading_error_empty_show_no_panel", async () => {
    const { container } = renderHistory();
    await screen.findByText("No history yet.");
    expect(container.querySelector(".sf-table-wrap")).toBeNull();
  });

  it("no_mode_kind_from_or_to_fields_remain", async () => {
    renderHistory();
    await screen.findByText("No history yet.");
    for (const name of ["Mode", "Kind", "From", "To"]) expect(screen.queryByLabelText(name), name).toBeNull();
    for (const name of ["Who", "Task", "When"]) {
      const control = screen.getByLabelText(name);
      expect(control.tagName, name).toBe("SELECT");
      expect(control, name).toHaveClass("sf-select");
      expect(control.closest(".sf-inline-field"), name).not.toBeNull();
    }
  });
});

describe("HistoryView at 360px", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = atPhoneWidth();
  });
  afterEach(() => restore());

  it("history_fits_360", async () => {
    seedTaskRow("T-1");
    await addEvents(event("T-1", "you", "status", "2026-11-01T10:00:00.000Z"));
    const { container } = renderHistory();
    expect(await screen.findByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "History" })).toBeInTheDocument();
    expect(tooWide(BOARD_CSS, renderedClasses(container, BOARD_CSS))).toEqual([]);
  });
});
