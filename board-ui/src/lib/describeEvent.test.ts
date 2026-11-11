import { describe, expect, it } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { describeEvent, eventContexts } from "./describeEvent";
import { parseQuestion } from "../features/task/parseQuestion";

const ev = (over: Partial<FactoryEvent>): FactoryEvent => ({
  action: "set",
  actor: "you",
  at: "2026-11-01T12:00:00.000Z",
  factoryId: "blocks",
  field: "status",
  from: null,
  reason: "x",
  taskId: "T-1",
  to: null,
  ...over
});

const QUESTION = "Which base?\nMore detail\nA. main: x (recommended)\nB. dev: y\nC. other: z\nReply with an option letter, or answer in your own words.";

describe("describeEvent", () => {
  it("status_move_shows_the_to_status_as_a_chip", () => {
    const out = describeEvent(ev({ action: "move", field: "status", from: "spec", to: "spec_review", reason: "moved" }));
    expect(out.parts).toEqual(["status spec → ", { status: "spec_review", label: "Spec review" }]);
    expect(out.text).toBe("status spec → Spec review");
  });

  it("spec_written_with_version", () => {
    const move = ev({ action: "move", field: "status", from: "spec", to: "spec_review", reason: "spec written, awaiting review" });
    expect(describeEvent(move, { docVersion: 2 }).text).toBe("Spec v2 written");
    expect(describeEvent(move).text).toBe("Spec written");
  });

  it("plan_written_with_version", () => {
    const move = ev({ action: "move", field: "status", from: "plan", to: "plan_review", reason: "plan written" });
    expect(describeEvent(move, { docVersion: 1 }).text).toBe("Plan v1 written");
  });

  it("requested_changes_on_a_gate", () => {
    expect(describeEvent(ev({ field: "approval", to: "spec:changes@v1" })).text).toBe("Requested changes on spec v1");
  });

  it("approved_a_gate", () => {
    expect(describeEvent(ev({ field: "approval", to: "plan:approve@v3" })).text).toBe("Approved plan v3");
  });

  it("asked_question_first_line_and_option_count", () => {
    expect(describeEvent(ev({ field: "question", to: QUESTION })).text).toBe('Asked: "Which base?" · 3 options');
  });

  it("answered_with_known_question", () => {
    const prompt = parseQuestion(QUESTION).prompt.replace(/\s+/g, " ").trim();
    const out = describeEvent(ev({ field: "answer", reason: "answered", to: "B. dev: y" }), { question: QUESTION });
    expect(out.text).toBe(`Answered "${prompt}" with B. dev: y`);
  });

  it("answered_with_the_recommended_answer", () => {
    const out = describeEvent(ev({ field: "answer", reason: "answered", to: "A.  main: x" }), { question: QUESTION });
    expect(out.text.endsWith(", the recommended answer")).toBe(true);
    expect(out.text.startsWith("Answered \"")).toBe(true);
  });

  it("answered_without_a_known_question", () => {
    expect(describeEvent(ev({ field: "answer", reason: "answered", to: "B" }), { question: null }).text).toBe("Answered with B");
  });

  it("marked_ready", () => {
    expect(describeEvent(ev({ action: "move", field: "status", from: "inbox", to: "ready", reason: "marked ready" })).text).toBe("Marked ready");
  });

  it("created_in_inbox", () => {
    expect(describeEvent(ev({ action: "create", field: null, to: "inbox" })).text).toBe("Created in inbox");
    expect(describeEvent(ev({ action: "create", field: null, to: "ready" })).text).toBe("Created in ready");
  });

  it("cancelled", () => {
    expect(describeEvent(ev({ action: "move", field: "status", from: "build", to: "cancelled", reason: "cancelled" })).text).toBe("Cancelled");
  });

  it("waits_for_dependencies", () => {
    expect(describeEvent(ev({ field: "dependsOn", to: '["T-3","T-5"]' })).text).toBe("Waits for T-3, T-5");
    expect(describeEvent(ev({ field: "dependsOn", to: "[]" })).text).toBe("Waits for no tasks");
  });

  it("setting_set_to_value", () => {
    expect(describeEvent(ev({ taskId: "-", field: "settings.global.maxParallel", to: "3" })).text).toBe("maxParallel set to 3");
    expect(describeEvent(ev({ taskId: "-", field: "settings.iam.gates", to: "inherit" })).text).toBe("gates set to inherit");
    expect(describeEvent(ev({ taskId: "-", field: "def.name", to: "Delta Two" })).text).toBe("name set to Delta Two");
    expect(describeEvent(ev({ taskId: "-", field: "repo.api.checks", to: '{"a":2}' })).text).toBe('checks set to {"a":2}');
  });

  it("fallback_field_from_to", () => {
    expect(describeEvent(ev({ field: "branch", from: null, to: "feat/x  y" })).text).toBe("branch: — → feat/x y");
    expect(describeEvent(ev({ field: null, action: "move", from: "a", to: "b" })).text.startsWith("move: ")).toBe(true);
  });

  it("describeEvent_is_pure", () => {
    const input = ev({ action: "move", field: "status", from: "spec", to: "spec_review", reason: "moved" });
    const copy = structuredClone(input);
    expect(describeEvent(input)).toEqual(describeEvent(input));
    expect(input).toEqual(copy);
  });
});

describe("eventContexts", () => {
  it("eventContexts_counts_doc_versions_per_task_and_kind", () => {
    const spec1 = ev({ action: "move", taskId: "T-1", reason: "spec written, awaiting review", at: "2026-11-01T01:00:00.000Z" });
    const spec2 = ev({ action: "move", taskId: "T-1", reason: "spec written", at: "2026-11-01T02:00:00.000Z" });
    const plan1 = ev({ action: "move", taskId: "T-1", reason: "plan written", at: "2026-11-01T03:00:00.000Z" });
    const other = ev({ action: "move", taskId: "T-2", reason: "spec written", at: "2026-11-01T04:00:00.000Z" });
    const contexts = eventContexts([other, plan1, spec2, spec1]);
    expect(contexts.get(spec1)?.docVersion).toBe(1);
    expect(contexts.get(spec2)?.docVersion).toBe(2);
    expect(contexts.get(plan1)?.docVersion).toBe(1);
    expect(contexts.get(other)?.docVersion).toBe(1);
  });

  it("eventContexts_pairs_an_answer_with_the_latest_question_before_it", () => {
    const q1 = ev({ field: "question", to: "Q1" });
    const q2 = ev({ field: "question", to: "Q2" });
    const answer = ev({ field: "answer", reason: "answered", to: "A" });
    expect(eventContexts([answer, q2, q1]).get(answer)?.question).toBe("Q2");

    const cleared = ev({ field: "question", to: null });
    const answer2 = ev({ field: "answer", reason: "answered", to: "A" });
    expect(eventContexts([answer2, cleared, q1]).get(answer2)?.question).toBeNull();
  });
});
