import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { blocksFactories, factory, merge } from "../../test/factories";
import { fakeBoard, renderWithClient, resetFakeBoard } from "../../test/fakeBoard";
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

/** The Field cell of every row, top to bottom. */
function fields(): string[] {
  const table = screen.getByRole("table", { name: "History" });
  return within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[3]!.textContent ?? "");
}

// Noon UTC: the same local date in every time zone the tests may run in.
const DAY1 = "2026-11-01T12:00:00.000Z";
const DAY2 = "2026-11-02T12:00:00.000Z";
const DAY3 = "2026-11-03T12:00:00.000Z";

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
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

  it("shows_time_actor_task_field_change_and_reason", async () => {
    seedTaskRow("T-7");
    const long = "x".repeat(200);
    await addEvents(
      event("T-7", "implementer · session · run R9", "branch", DAY1, null, long),
      event("-", "you", "settings.iam.gates", DAY2, '{"pr":false}', "inherit")
    );
    const { onNavigate } = renderHistory();
    const table = await screen.findByRole("table", { name: "History" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Time", "Actor", "Task", "Field", "Change", "Reason"]);

    const [settingsRow, taskRow] = within(table).getAllByRole("row").slice(1);
    expect(within(settingsRow!).getByText("Settings")).toBeInTheDocument();
    expect(within(settingsRow!).queryByRole("link")).not.toBeInTheDocument();
    expect(within(settingsRow!).getByText('{"pr":false} → inherit')).toHaveClass("sf-mono");

    const link = within(taskRow!).getByRole("link", { name: "T-7" });
    expect(link).toHaveAttribute("href", "/tasks/T-7");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("/tasks/T-7");
    expect(within(taskRow!).getByText("implementer · session · run R9")).toBeInTheDocument();
    expect(within(taskRow!).getByText("branch by implementer")).toBeInTheDocument();
    const change = within(taskRow!).getByTitle(`— → ${long}`);
    expect(change.textContent!.length).toBeLessThan(120);
    expect(taskRow!.querySelector("time")).toHaveAttribute("dateTime", DAY1);
  });

  it("narrows_the_rows_by_actor_mode_task_and_date", async () => {
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
    expect(fields()).toHaveLength(5);

    fireEvent.change(screen.getByLabelText("Actor"), { target: { value: "core" } });
    expect(fields()).toEqual(["branch"]);
    fireEvent.change(screen.getByLabelText("Actor"), { target: { value: "you" } });
    expect(fields()).toEqual(["settings.global.paused", "title"]);
    fireEvent.change(screen.getByLabelText("Actor"), { target: { value: "all" } });

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "loop" } });
    expect(fields()).toEqual(["status", "branch"]);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "all" } });

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "-" } });
    expect(fields()).toEqual(["settings.global.paused"]);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "T-1" } });
    expect(fields()).toEqual(["stage", "title"]);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "" } });

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-02" } });
    expect(fields()).toEqual(["stage", "branch"]);
  });

  it("offers_the_task_ids_and_settings_in_the_task_filter", async () => {
    seedTaskRow("T-2");
    seedTaskRow("T-10");
    renderHistory();
    const select = await screen.findByLabelText("Task");
    await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All tasks", "Settings and factories", "T-2", "T-10"]));
  });

  it("says_so_when_the_filters_match_nothing", async () => {
    seedTaskRow("T-1");
    await addEvents(event("T-1", "you", "title", DAY1));
    renderHistory();
    await screen.findByRole("table", { name: "History" });
    fireEvent.change(screen.getByLabelText("Actor"), { target: { value: "verifier" } });
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
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(fields()).toHaveLength(250);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
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
    expect(fields()).toEqual(["repo.api.checks", "def.name", "settings.blocks.maxParallel"]);
    const picker = screen.getByLabelText("Factory", { selector: "select" });
    await waitFor(() => expect(picker.querySelector('option[value="delta"]')).not.toBeNull());
    fireEvent.change(picker, { target: { value: "delta" } });
    expect(fields()).toEqual(["repo.api.checks", "def.name"]);
    fireEvent.change(picker, { target: { value: "blocks" } });
    expect(fields()).toEqual(["settings.blocks.maxParallel"]);
    fireEvent.change(picker, { target: { value: "all" } });
    expect(fields()).toHaveLength(3);
  });

  it("shows_a_definition_events_field_old_and_new_values", async () => {
    await addEvents(forFactory("delta", "def.name", DAY1, "Delta", "Delta Two"));
    renderHistory();
    const row = (await screen.findByText("def.name")).closest("tr")!;
    expect(within(row).getByText("Factory")).toBeInTheDocument();
    expect(within(row).getByText("Delta → Delta Two")).toBeInTheDocument();
  });
});
