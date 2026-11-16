import { describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { filterEvents, NO_FILTERS, type HistoryFilters } from "./useHistory";

vi.mock("../../lib/board", () => ({ boardStore: {} }));

const now = new Date(2026, 10, 12, 15, 0);
const day = (d: number) => new Date(2026, 10, d, 12).toISOString();

const ev = (field: string, to: string | null, over: Partial<FactoryEvent> = {}): FactoryEvent => ({
  action: "set", actor: "you", at: day(12), factoryId: "tsf", field, from: null, reason: "x", taskId: "T-1", to, ...over
});
const all: HistoryFilters = { ...NO_FILTERS, when: "all" };
const run = (events: readonly FactoryEvent[], filters: Partial<HistoryFilters>, titles?: Record<string, string>) =>
  filterEvents(events, { ...all, ...filters }, { now, titles });

describe("NO_FILTERS", () => {
  it("NO_FILTERS_defaults", () => {
    expect(NO_FILTERS).toEqual({ search: "", actor: "all", task: "", when: "7d", pill: "all", factory: "" });
  });
});

describe("filterEvents pills", () => {
  const events = [
    ev("status", "build", { action: "move", actor: "core · loop" }),
    ev("question", "Which?", { reason: "asked", actor: "spec-writer · sdk · run R" }),
    ev("answer", "A", { reason: "answered" }),
    ev("answer", "fix", { reason: "spec changes requested" }),
    ev("settings.global.paused", "true", { taskId: "-" })
  ];

  it("pill_qa_keeps_question_and_answered_answer_events_only", () => {
    expect(run(events, { pill: "qa" }).map((e) => e.field)).toEqual(["question", "answer"]);
    expect(run(events, { pill: "qa" })[1]!.reason).toBe("answered");
    expect(run([events[3]!], { pill: "qa" })).toEqual([]);
    expect(run([ev("question", null)], { pill: "qa" })).toEqual([]);
  });

  it("pill_you_keeps_owner_events", () => {
    expect(run(events, { pill: "you" }).map((e) => e.field)).toEqual(["answer", "answer", "settings.global.paused"]);
  });

  it("pill_moves_keeps_action_move", () => {
    expect(run(events, { pill: "moves" })).toEqual([events[0]]);
  });

  it("pill_settings_keeps_dash_task_events", () => {
    expect(run(events, { pill: "settings" })).toEqual([events[4]]);
  });

  it("pill_combines_with_actor_and_task_filters", () => {
    const other = ev("question", "Other?", { taskId: "T-2", actor: "spec-writer · sdk · run R" });
    const list = [...events, other];
    expect(run(list, { pill: "qa", actor: "you" }).map((e) => e.field)).toEqual(["answer"]);
    expect(run(list, { pill: "qa", task: "T-2" })).toEqual([other]);
  });
});

describe("filterEvents actor", () => {
  it("actor_core_matches_core_new", () => {
    const events = [ev("a", null, { actor: "core · loop" }), ev("b", null, { actor: "core · new" }), ev("c", null)];
    expect(run(events, { actor: "core" }).map((e) => e.field)).toEqual(["a", "b"]);
  });
});

describe("filterEvents when", () => {
  const at = (d: number) => ev(`d${d}`, null, { at: day(d) });

  it("when_today_keeps_only_todays_local_date", () => {
    expect(run([at(12), at(11)], { when: "today" }).map((e) => e.field)).toEqual(["d12"]);
  });

  it("when_7d_keeps_today_minus_6_days_and_drops_minus_7", () => {
    expect(run([at(12), at(6), at(5)], { when: "7d" }).map((e) => e.field)).toEqual(["d12", "d6"]);
  });

  it("when_30d_keeps_minus_29_and_drops_minus_30", () => {
    const keep = ev("keep", null, { at: new Date(2026, 9, 14, 12).toISOString() });
    const drop = ev("drop", null, { at: new Date(2026, 9, 13, 12).toISOString() });
    expect(run([keep, drop], { when: "30d" }).map((e) => e.field)).toEqual(["keep"]);
  });

  it("when_all_keeps_everything_including_unparseable_at", () => {
    const events = [at(12), ev("old", null, { at: "2020-01-01T00:00:00.000Z" }), ev("bad", null, { at: "nope" })];
    expect(run(events, { when: "all" })).toHaveLength(3);
  });

  it("unparseable_at_is_dropped_for_today_7d_30d", () => {
    const bad = ev("bad", null, { at: "nope" });
    for (const when of ["today", "7d", "30d"] as const) expect(run([bad], { when })).toEqual([]);
  });
});

describe("filterEvents search", () => {
  it("search_matches_task_id_case_insensitive", () => {
    expect(run([ev("a", null), ev("b", null, { taskId: "T-2" })], { search: "t-1" }).map((e) => e.field)).toEqual(["a"]);
  });

  it("search_matches_task_title", () => {
    const events = [ev("a", null), ev("b", null, { taskId: "T-2" })];
    expect(run(events, { search: "login" }, { "T-1": "Fix Login", "T-2": "Other" }).map((e) => e.field)).toEqual(["a"]);
  });

  it("search_matches_change_text", () => {
    const events = [ev("dependsOn", '["T-9"]'), ev("b", null)];
    expect(run(events, { search: "waits for t-9" }).map((e) => e.field)).toEqual(["dependsOn"]);
  });

  it("search_matches_reason", () => {
    const events = [ev("a", null, { reason: "Spec Written" }), ev("b", null)];
    expect(run(events, { search: "spec written" }).map((e) => e.field)).toEqual(["a"]);
  });

  it("search_is_trimmed_and_empty_matches_all", () => {
    expect(run([ev("a", null), ev("b", null)], { search: "   " })).toHaveLength(2);
  });
});
