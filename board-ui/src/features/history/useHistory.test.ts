import { describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { filterEvents, NO_FILTERS } from "./useHistory";

vi.mock("../../lib/board", () => ({ boardStore: {} }));

const ev = (field: string, to: string | null, over: Partial<FactoryEvent> = {}): FactoryEvent => ({
  action: "set", actor: "you", at: "2026-11-01T12:00:00.000Z", factoryId: "tsf", field, from: null, reason: "x", taskId: "T-1", to, ...over
});
const qa = { ...NO_FILTERS, kind: "qa" as const };

describe("filterEvents kind qa", () => {
  const events = [
    ev("status", "build"),
    ev("question", "Which?", { reason: "asked", actor: "spec-writer · sdk · run R" }),
    ev("answer", "A", { reason: "answered" }),
    ev("answer", "fix", { reason: "spec changes requested" })
  ];

  it("qa_kind_keeps_question_and_answered_answer_events_only", () => {
    expect(filterEvents(events, qa).map((e) => e.field)).toEqual(["question", "answer"]);
    expect(filterEvents(events, qa)[1]!.reason).toBe("answered");
  });

  it("qa_kind_drops_answer_events_with_other_reasons", () => {
    expect(filterEvents([events[3]!], qa)).toEqual([]);
  });

  it("qa_kind_drops_a_question_cleared_to_null", () => {
    expect(filterEvents([ev("question", null)], qa)).toEqual([]);
  });

  it("kind_all_is_the_default_in_NO_FILTERS", () => {
    expect(NO_FILTERS.kind).toBe("all");
    expect(filterEvents(events, NO_FILTERS)).toHaveLength(4);
  });

  it("qa_kind_combines_with_actor_and_task_filters", () => {
    const other = ev("question", "Other?", { taskId: "T-2", actor: "spec-writer · sdk · run R" });
    const all = [...events, other];
    expect(filterEvents(all, { ...qa, actor: "you" }).map((e) => e.field)).toEqual(["answer"]);
    expect(filterEvents(all, { ...qa, task: "T-2" })).toEqual([other]);
  });
});
