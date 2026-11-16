import type { FactoryEvent } from "@factory/core";
import { isAnswer, isQuestion } from "../../lib/qaEvent";
import { formatTime } from "../../lib/formatTime";
import { ageOf } from "../board/status";
import { optionText, parseQuestion, type QuestionOption } from "./parseQuestion";

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
  /** The working status each `blocked` move left, keyed by the move's time; a question shares its move's time. */
  const blockedFrom = new Map<string, string | null>();
  let cleared = false;
  for (const event of events) {
    if (event.field === "status" && event.to === "blocked" && !blockedFrom.has(event.at)) blockedFrom.set(event.at, event.from);
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
      const stage = blockedFrom.get(event.at) ?? null;
      return {
        answer: given,
        answeredAt: answer?.at ?? null,
        askedAt: event.at,
        askedBy: askerName(event.actor),
        key: `${index}:${event.at}`,
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
function clockOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "today HH:MM" for a time on the viewer's local today, otherwise the locale date and time. */
export function timeLabel(iso: string, nowMs: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toDateString() === new Date(nowMs).toDateString() ? `today ${clockOf(iso)}` : formatTime(iso);
}

/** "Question N · spec writer · spec stage · today 08:14"; the asker and stage parts are left out when unknown. */
export function qaLabelLine(entry: QaEntry, nowMs: number = Date.now()): string {
  const parts = [`Question ${entry.number}`];
  if (entry.askedBy) parts.push(entry.askedBy.toLowerCase());
  if (entry.stage) parts.push(`${entry.stage} stage`);
  parts.push(timeLabel(entry.askedAt, nowMs));
  return parts.join(" · ");
}

/**
 * "Answered by you · today 07:58", plus "· the spec writer resumed at 07:59" when a resume was seen; null when unanswered.
 * A resume on a different day from the answer carries its day too, so it never reads as earlier than the answer.
 */
export function answeredLine(entry: QaEntry, nowMs: number = Date.now()): string | null {
  if (entry.answeredAt === null) return null;
  const line = `Answered by you · ${timeLabel(entry.answeredAt, nowMs)}`;
  if (entry.resumedAt === null) return line;
  const who = entry.askedBy ? `the ${entry.askedBy.toLowerCase()}` : "the task";
  const sameDay = new Date(entry.resumedAt).toDateString() === new Date(entry.answeredAt).toDateString();
  return `${line} · ${who} resumed at ${sameDay ? clockOf(entry.resumedAt) : timeLabel(entry.resumedAt, nowMs)}`;
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

/** The answer view's from line: "Spec writer · <task title>" from the latest question event; the title alone without an asker. */
export function questionFromLine(events: readonly FactoryEvent[], title: string): string {
  const questions = events.filter(isQuestion);
  const latest = questions[questions.length - 1];
  const asker = latest ? askerName(latest.actor) : "";
  return asker ? `${asker} · ${title}` : title;
}

/**
 * "You answered A. jsdom tests (recommended) at 07:58" for an earlier question: the chosen option as "<letter>. <label>"
 * (with " (recommended)" when it was the recommended one) or the free-text answer, then local HH:MM when answered today,
 * else the locale date and time. Null when there is no answer.
 */
export function earlierAnsweredLine(entry: QaEntry, nowMs: number = Date.now()): string | null {
  if (entry.answer === null || entry.answeredAt === null) return null;
  const chosen = entry.options.find((option) => option.chosen);
  const answer = chosen ? `${chosen.letter}. ${chosen.label}${chosen.recommended ? " (recommended)" : ""}` : entry.answer;
  const date = new Date(entry.answeredAt);
  const today = !Number.isNaN(date.getTime()) && date.toDateString() === new Date(nowMs).toDateString();
  return `You answered ${answer} at ${today ? clockOf(entry.answeredAt) : formatTime(entry.answeredAt)}`;
}
