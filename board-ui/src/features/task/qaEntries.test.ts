import { describe, expect, it } from "vitest";
import type { FactoryEvent } from "@factory/core";
import { answeredLine, askerLine, askerName, buildQaLog, qaCounts, qaLabelLine, timeLabel, type QaEntry } from "./qaEntries";

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

function st(from: string | null, to: string | null, reason: string, at: string): FactoryEvent {
  return { action: "move", actor: "core", at, factoryId: "tsf", field: "status", from, reason, taskId: "T-1", to };
}

const localIso = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).toISOString();

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

  it("the_open_question_is_kept_flagged_and_first", () => {
    const open = ev("question", "Open?");
    expect(buildQaLog([ev("question", "Old?"), ev("answer", "y"), open], "Open?").map((e) => [e.question, e.open])).toEqual([["Open?", true], ["Old?", false]]);
    expect(buildQaLog([open], null).map((e) => [e.question, e.open])).toEqual([["Open?", false]]);
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

  it("flags_the_open_question_even_when_it_is_not_the_last_event_or_text_differs_by_whitespace", () => {
    const entries = buildQaLog([ev("question", "Old?"), ev("question", "Open?\n"), ev("question", null), ev("answer", "stray")], "Open?");
    expect(entries.map((e) => [e.question.trim(), e.open, e.answer])).toEqual([["Open?", true, null], ["Old?", false, null]]);
  });

  it("keeps_the_latest_question_when_it_is_not_the_open_one", () => {
    const entries = buildQaLog([ev("question", "First?"), ev("answer", "1"), ev("question", "Second?")], "Reworded?");
    expect(entries.map((e) => e.question)).toEqual(["Second?", "First?"]);
    expect(entries.every((e) => e.open === false)).toBe(true);
  });

  it("falls_back_to_choose_an_answer_for_an_options_only_question", () => {
    const [entry] = buildQaLog([ev("question", "A. main: fits\nB. develop: more")], null);
    expect(entry?.question).toBe("Choose an answer");
  });

  it("flags_only_the_latest_question_as_open_even_when_answered", () => {
    const entries = buildQaLog([ev("question", "Q1?"), ev("question", "Q2?"), ev("answer", "yes")], "Q2?");
    expect(entries.map((e) => [e.question, e.answer, e.open])).toEqual([["Q2?", "yes", true], ["Q1?", null, false]]);
  });

  it("marks_recommended_when_the_answer_differs_only_by_extra_spaces", () => {
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "A.  main:   fits")], null)[0]?.mark).toBe("recommended");
  });
});

describe("buildQaLog numbering, stage and open flag", () => {
  it("numbers_questions_oldest_first_from_one", () => {
    const entries = buildQaLog([ev("question", "One?"), ev("question", null), ev("question", "Two?"), ev("question", "Three?")], null);
    expect(entries.map((e) => e.number)).toEqual([3, 2, 1]);
  });

  it("stage_is_the_from_of_the_blocked_move_sharing_the_question_time", () => {
    const at = "2026-11-05T09:00:00.000Z";
    const q = ev("question", LETTERED, { at });
    const move = st("spec", "blocked", "agent blocked", at);
    expect(buildQaLog([move, q], null)[0]?.stage).toBe("spec");
    expect(buildQaLog([q, move], null)[0]?.stage).toBe("spec");
  });

  it("stage_is_null_without_a_blocked_move_at_the_same_time", () => {
    const q = ev("question", LETTERED, { at: "2026-11-05T09:00:00.000Z" });
    expect(buildQaLog([q, st("spec", "blocked", "agent blocked", "2026-11-05T09:00:01.000Z")], null)[0]?.stage).toBeNull();
  });

  it("entry_carries_asked_at", () => {
    const q = ev("question", LETTERED, { at: "2026-11-05T09:00:00.000Z" });
    expect(buildQaLog([q], null)[0]?.askedAt).toBe(q.at);
  });
});

describe("buildQaLog option marks, resume and counts", () => {
  const chosen = (answer: string) => buildQaLog([ev("question", LETTERED), ev("answer", answer)], null)[0]!.options.map((o) => o.chosen);

  it("marks_the_chosen_option_for_full_text_letter_and_letter_with_dot", () => {
    expect(chosen("A. main: fits")).toEqual([true, false]);
    expect(chosen("A")).toEqual([true, false]);
    expect(chosen("A.")).toEqual([true, false]);
    expect(chosen("A.  main:   fits")).toEqual([true, false]);
    expect(chosen("B")).toEqual([false, true]);
  });

  it("recommended_flag_is_kept_on_options", () => {
    const [entry] = buildQaLog([ev("question", LETTERED)], null);
    expect(entry?.options.map((o) => o.recommended)).toEqual([true, false]);
  });

  it("free_text_answer_chooses_no_option", () => {
    const [entry] = buildQaLog([ev("question", LETTERED), ev("answer", "use release")], null);
    expect(entry?.options.every((o) => !o.chosen)).toBe(true);
    expect(entry?.answer).toBe("use release");
    expect(chosen("A. something else")).toEqual([false, false]);
  });

  it("resumed_at_is_set_by_a_later_question_answered_move_from_blocked", () => {
    const resume = st("blocked", "spec", "question answered", "2026-11-20T10:00:00.000Z");
    const [entry] = buildQaLog([ev("question", LETTERED), ev("answer", "A"), resume], null);
    expect(entry?.resumedAt).toBe(resume.at);
  });

  it("resumed_at_is_null_without_that_event", () => {
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "A")], null)[0]?.resumedAt).toBeNull();
    const other = st("blocked", "spec", "unblocked", "2026-11-20T10:00:00.000Z");
    expect(buildQaLog([ev("question", LETTERED), ev("answer", "A"), other], null)[0]?.resumedAt).toBeNull();
    const late = st("blocked", "spec", "question answered", "2026-11-21T10:00:00.000Z");
    const entries = buildQaLog([ev("question", "First?"), ev("answer", "A"), ev("question", "Second?"), ev("answer", "B"), late], null);
    expect(entries.map((e) => [e.question, e.resumedAt])).toEqual([["Second?", late.at], ["First?", null]]);
  });

  it("resumed_at_needs_an_answer_first", () => {
    const resume = st("blocked", "spec", "question answered", "2026-11-20T10:00:00.000Z");
    expect(buildQaLog([ev("question", LETTERED), resume, ev("answer", "A")], null)[0]?.resumedAt).toBeNull();
  });

  it("counts_asked_and_answered", () => {
    const entries = buildQaLog([ev("question", "1?"), ev("answer", "a"), ev("question", "2?"), ev("answer", "b"), ev("question", "3?")], null);
    expect(qaCounts(entries)).toEqual({ asked: 3, answered: 2 });
  });
});

describe("qa line helpers", () => {
  const now = new Date(2026, 10, 11, 12, 0).getTime();
  const base: QaEntry = {
    key: "k", question: "Q?", askedBy: "Spec writer", askedAt: localIso(11, 8, 14), number: 2, stage: "spec", options: [],
    answer: "A", answeredAt: localIso(11, 7, 58), resumedAt: null, open: false, mark: "none"
  };

  it("time_label_is_today_hh_mm_for_today", () => {
    expect(timeLabel(localIso(11, 8, 14), now)).toBe("today 08:14");
  });

  it("time_label_is_locale_date_time_otherwise", () => {
    const iso = localIso(9, 8, 14);
    expect(timeLabel(iso, now)).toBe(new Date(iso).toLocaleString());
  });

  it("label_line_has_number_asker_stage_and_time", () => {
    expect(qaLabelLine(base, now)).toBe("Question 2 · spec writer · spec stage · today 08:14");
  });

  it("label_line_leaves_out_a_null_stage", () => {
    expect(qaLabelLine({ ...base, number: 1, stage: null }, now)).toBe("Question 1 · spec writer · today 08:14");
  });

  it("answered_line_without_resume", () => {
    expect(answeredLine(base, now)).toBe("Answered by you · today 07:58");
  });

  it("answered_line_with_resume", () => {
    expect(answeredLine({ ...base, resumedAt: localIso(11, 7, 59) }, now)).toBe("Answered by you · today 07:58 · the spec writer resumed at 07:59");
  });

  it("answered_line_is_null_when_unanswered", () => {
    expect(answeredLine({ ...base, answer: null, answeredAt: null }, now)).toBeNull();
  });

  it("asker_line_has_asker_number_and_age", () => {
    const events = [ev("question", "One?"), ev("question", null), ev("question", "Two?", { at: "2026-11-01T10:00:00.000Z" })];
    expect(askerLine(events, Date.parse("2026-11-01T15:00:00.000Z"))).toBe("Spec writer asks · question 2 of this task · 5h ago");
  });

  it("asker_line_says_just_now_without_ago", () => {
    const events = [ev("question", "One?", { at: "2026-11-01T10:00:00.000Z" })];
    const line = askerLine(events, Date.parse("2026-11-01T10:00:30.000Z"));
    expect(line).toBe("Spec writer asks · question 1 of this task · just now");
    expect(line).not.toMatch(/ago/);
  });

  it("asker_line_is_empty_without_a_question_event", () => {
    expect(askerLine([], now)).toBe("");
  });
});
