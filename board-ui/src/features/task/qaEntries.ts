import type { FactoryEvent } from "@factory/core";
import { isAnswer, isQuestion } from "../../lib/qaEvent";
import { ageOf } from "../board/status";
import { optionText, parseQuestion, type QuestionOption } from "./parseQuestion";

export type QaMark = "recommended" | "not-recommended" | "none";
export type QaOption = QuestionOption & { chosen: boolean };
export type QaEntry = {
  key: string;
  /** 1-based position among the task's questions, oldest first. */
  number: number;
  question: string;
  askedBy: string;
  askedAt: string;
  /** The working status the task was blocked from when the question was asked, or null when unknown. */
  stage: string | null;
  options: QaOption[];
  /** The raw answer text. */
  answer: string | null;
  answeredAt: string | null;
  /** When the asker resumed after the answer, or null when no event shows it. */
  resumedAt: string | null;
  /** True for the question that is still open. */
  open: boolean;
  mark: QaMark;
};

const humanise = (text: string): string => {
  const spaced = text.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Who asked, from the first segment of an event actor: `spec-writer · sdk · run R-1` is "Spec writer", `core` is "Factory". */
export function askerName(actor: string): string {
  const first = actor.split(" · ")[0]?.trim() ?? "";
  return first === "core" ? "Factory" : humanise(first);
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function markOf(options: readonly QuestionOption[], answer: string): QaMark {
  const marked = options.filter((option) => option.recommended);
  if (marked.length !== 1) return "none";
  return collapse(answer) === collapse(optionText(marked[0]!)) ? "recommended" : "not-recommended";
}

/** An answer picks an option when it is the option's full text (whitespace collapsed) or its bare letter (`A` or `A.`). */
function chosenOf(option: QuestionOption, answer: string): boolean {
  if (collapse(answer) === collapse(optionText(option))) return true;
  return /^([A-D])\.?$/.exec(answer.trim())?.[1] === option.letter;
}

const isResume = (event: FactoryEvent): boolean => event.field === "status" && event.from === "blocked" && event.reason === "question answered";

/**
 * Every question with its answer, newest first. `events` are oldest first. An answer pairs with the latest
 * question before it, and a later resume move (from `blocked`, "question answered") before the next question sets
 * `resumedAt`. While a question is open (`openQuestion`) the latest question event, the one that set it, is flagged `open`.
 */
export function buildQaLog(events: readonly FactoryEvent[], openQuestion: string | null): QaEntry[] {
  const asked: { event: FactoryEvent; answer: FactoryEvent | null; resumedAt: string | null }[] = [];
  let cleared = false;
  for (const event of events) {
    const last = asked[asked.length - 1];
    if (isQuestion(event)) {
      asked.push({ answer: null, event, resumedAt: null });
      cleared = false;
    } else if (event.field === "question") cleared = true;
    else if (isAnswer(event) && !cleared) {
      if (last && last.answer === null) last.answer = event;
    } else if (isResume(event) && last && last.answer !== null && last.resumedAt === null) last.resumedAt = event.at;
  }
  const latest = asked[asked.length - 1];
  const openIndex = openQuestion !== null && latest && (latest.event.to ?? "").trim() === openQuestion.trim() ? asked.length - 1 : -1;
  return asked
    .map(({ answer, event, resumedAt }, index): QaEntry => {
      const parsed = parseQuestion(event.to ?? "");
      const given = answer?.to ?? null;
      const stage = events.find((e) => e.field === "status" && e.to === "blocked" && e.at === event.at)?.from ?? null;
      return {
        answer: given,
        answeredAt: answer?.at ?? null,
        askedAt: event.at,
        askedBy: askerName(event.actor),
        key: `${index}:${event.at}`,
        mark: given === null ? "none" : markOf(parsed.options, given),
        number: index + 1,
        open: index === openIndex,
        options: parsed.options.map((option) => ({ ...option, chosen: given !== null && chosenOf(option, given) })),
        question: parsed.prompt || "Choose an answer",
        resumedAt,
        stage
      };
    })
    .reverse();
}

/** The counts in the log header: questions asked and questions with an answer. */
export function qaCounts(entries: readonly QaEntry[]): { asked: number; answered: number } {
  return { asked: entries.length, answered: entries.filter((entry) => entry.answer !== null).length };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Local `HH:MM` of an ISO time. */
export function clockOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "today HH:MM" for a time on the viewer's local today, otherwise the locale date and time. */
export function timeLabel(iso: string, nowMs: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toDateString() === new Date(nowMs).toDateString() ? `today ${clockOf(iso)}` : date.toLocaleString();
}

/** "Question N · spec writer · spec stage · today 08:14"; the asker and stage parts are left out when unknown. */
export function qaLabelLine(entry: QaEntry, nowMs: number = Date.now()): string {
  const parts = [`Question ${entry.number}`];
  if (entry.askedBy) parts.push(entry.askedBy.toLowerCase());
  if (entry.stage) parts.push(`${entry.stage} stage`);
  parts.push(timeLabel(entry.askedAt, nowMs));
  return parts.join(" · ");
}

/** "Answered by you · today 07:58", plus "· the spec writer resumed at 07:59" when a resume was seen; null when unanswered. */
export function answeredLine(entry: QaEntry, nowMs: number = Date.now()): string | null {
  if (entry.answeredAt === null) return null;
  const line = `Answered by you · ${timeLabel(entry.answeredAt, nowMs)}`;
  if (entry.resumedAt === null) return line;
  const who = entry.askedBy ? `the ${entry.askedBy.toLowerCase()}` : "the task";
  return `${line} · ${who} resumed at ${clockOf(entry.resumedAt)}`;
}

/** "Spec writer asks · question 2 of this task · 5h ago" from the latest question event; "" when there is none. */
export function askerLine(events: readonly FactoryEvent[], nowMs: number = Date.now()): string {
  const questions = events.filter(isQuestion);
  const latest = questions[questions.length - 1];
  if (!latest) return "";
  const asker = askerName(latest.actor);
  const age = ageOf(latest.at, nowMs);
  const parts = [asker ? `${asker} asks` : "", `question ${questions.length} of this task`, age === null ? "" : age === "just now" ? age : `${age} ago`];
  return parts.filter((part) => part !== "").join(" · ");
}
