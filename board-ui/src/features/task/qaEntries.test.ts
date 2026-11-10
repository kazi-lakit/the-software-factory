import { describe, expect, it } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { askerName, buildQaLog } from "./qaEntries";

const LETTERED = "Which branch?\nA. main: fits (recommended)\nB. develop: more work\nReply with an option letter.";
const NONE = "Which branch?\nA. main: fits\nB. develop: more work";
const SPEC = "spec-writer · sdk · run R-1";

let n = 0;
function ev(field: "question" | "answer", to: string | null, opts: { actor?: string; reason?: string; at?: string } = {}): FactoryEvent {
  n += 1;
  return {
    action: "set", actor: opts.actor ?? (field === "question" ? SPEC : "you"), at: opts.at ?? `2026-11-0${n}T10:00:00.000Z`,
    factoryId: "tsf", field, from: null, reason: opts.reason ?? (field === "answer" ? "answered" : "asked"), taskId: "T-1", to
  };
}

describe("buildQaLog", () => {
  it("pairs_a_question_with_the_first_later_answered_answer", () => {
    const q = ev("question", LETTERED);
    const a1 = ev("answer", "A. main: fits");
    const a2 = ev("answer", "B. develop: more work");
    const [entry] = buildQaLog([q, a1, a2], null);
    expect(entry).toMatchObject({ question: "Which branch?", askedBy: "Spec writer", answer: "A. main: fits", answeredAt: a1.at });
  });

  it("marks_recommended_when_the_answer_letter_matches_the_single_recommended_option", () => {
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "A. main: fits")], null)[0]?.mark).toBe("recommended");
  });

  it("marks_not_recommended_for_another_letter_and_for_other_text", () => {
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "B. develop: more work")], null)[0]?.mark).toBe("not-recommended");
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "use release")], null)[0]?.mark).toBe("not-recommended");
  });

  it("no_mark_when_no_recommended_option_or_plain_text", () => {
    expect(buildQaLog([ev("question", NONE), ev("answer", "A. main: fits")], null)[0]?.mark).toBe("none");
    expect(buildQaLog([ev("question", "Continue?"), ev("answer", "yes")], null)[0]?.mark).toBe("none");
  });

  it("ignores_answer_events_whose_reason_is_not_answered", () => {
    const [entry] = buildQaLog([ev("question", "Continue?"), ev("answer", "fix it", { reason: "spec changes requested" })], null);
    expect(entry).toMatchObject({ answer: null, answeredAt: null, mark: "none" });
  });

  it("unanswered_past_question_has_no_answer_and_no_mark", () => {
    const [entry] = buildQaLog([ev("question", LETTERED)], null);
    expect(entry).toMatchObject({ answer: null, answeredAt: null, mark: "none" });
  });

  it("answer_after_the_next_question_does_not_pair_with_the_earlier_one", () => {
    const entries = buildQaLog([ev("question", "First?"), ev("question", "Second?"), ev("answer", "yes")], null);
    expect(entries.map((e) => [e.question, e.answer])).toEqual([["Second?", "yes"], ["First?", null]]);
  });

  it("entries_are_newest_first", () => {
    const entries = buildQaLog([ev("question", "First?"), ev("answer", "1"), ev("question", "Second?"), ev("answer", "2")], null);
    expect(entries.map((e) => e.question)).toEqual(["Second?", "First?"]);
  });

  it("asker_is_the_humanised_first_actor_segment", () => {
    expect(askerName(SPEC)).toBe("Spec writer");
    expect(askerName("core · loop")).toBe("Factory");
    expect(askerName("you")).toBe("You");
    expect(askerName("")).toBe("");
    expect(askerName("some-odd_actor · x")).toBe("Some odd actor");
  });

  it("the_currently_open_question_is_excluded", () => {
    const open = ev("question", "Open?");
    expect(buildQaLog([ev("question", "Old?"), ev("answer", "y"), open], "Open?").map((e) => e.question)).toEqual(["Old?"]);
    expect(buildQaLog([open], null).map((e) => e.question)).toEqual(["Open?"]);
  });

  it("a_cleared_question_event_is_not_an_entry", () => {
    expect(buildQaLog([ev("question", "Q?"), ev("answer", "y"), ev("question", null)], null)).toHaveLength(1);
  });
});

describe("buildQaLog review fixes", () => {
  it("an_other_answer_that_starts_with_the_letter_is_not_recommended", () => {
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "A. something else")], null)[0]?.mark).toBe("not-recommended");
  });

  it("does_not_pair_an_answer_across_a_cleared_question", () => {
    const [entry] = buildQaLog([ev("question", LETTERED), ev("question", null), ev("answer", "A. main: fits")], null);
    expect(entry?.answer).toBeNull();
  });

  it("gives_each_entry_a_stable_key", () => {
    const keys = buildQaLog([ev("question", LETTERED), ev("question", LETTERED)], null).map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("drops_the_open_question_even_when_it_is_not_the_last_event_or_text_differs_by_whitespace", () => {
    const entries = buildQaLog([ev("question", "Old?"), ev("question", "Open?\n"), ev("question", null), ev("answer", "stray")], "Open?");
    expect(entries.map((e) => e.question)).toEqual(["Old?"]);
  });

  it("drops_only_the_last_unanswered_when_the_open_text_matches_nothing", () => {
    const entries = buildQaLog([ev("question", "First?"), ev("answer", "1"), ev("question", "Second?")], "Reworded?");
    expect(entries.map((e) => e.question)).toEqual(["First?"]);
  });

  it("keeps_an_older_unanswered_question_and_drops_only_the_latest_question_even_when_answered", () => {
    const entries = buildQaLog([ev("question", "Q1?"), ev("question", "Q2?"), ev("answer", "yes")], "Q2?");
    expect(entries.map((e) => [e.question, e.answer])).toEqual([["Q1?", null]]);
  });

  it("marks_recommended_when_the_answer_differs_only_by_extra_spaces", () => {
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "A.  main:   fits")], null)[0]?.mark).toBe("recommended");
  });
});
