import type { FactoryEvent } from "@factory/core";
import { parseQuestion, recommendedLetter } from "./parseQuestion";

export type QaMark = "recommended" | "not-recommended" | "none";
export type QaEntry = { question: string; askedBy: string; answer: string | null; answeredAt: string | null; mark: QaMark };

const isQuestion = (event: FactoryEvent): boolean => event.field === "question" && event.to !== null;
const isAnswer = (event: FactoryEvent): boolean => event.field === "answer" && event.reason === "answered" && event.to !== null;

/** A question set, or an answer the owner gave. Other `answer` writes (gate change requests) are not Q and A. */
export const isQaEvent = (event: FactoryEvent): boolean => isQuestion(event) || isAnswer(event);

const humanise = (text: string): string => {
  const spaced = text.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Who asked, from the first segment of an event actor: `spec-writer · sdk · run R-1` is "Spec writer", `core` is "Factory". */
export function askerName(actor: string): string {
  const first = actor.split(" · ")[0]?.trim() ?? "";
  return first === "core" ? "Factory" : humanise(first);
}

function markOf(options: ReturnType<typeof parseQuestion>["options"], answer: string): QaMark {
  const letter = recommendedLetter(options);
  if (letter === undefined) return "none";
  return answer.trimStart().startsWith(`${letter}.`) ? "recommended" : "not-recommended";
}

/**
 * The earlier questions with their answers, newest first. `events` are oldest first. An answer pairs with the
 * latest question before it; the question still open (`openQuestion`) is left out.
 */
export function buildQaLog(events: readonly FactoryEvent[], openQuestion: string | null): QaEntry[] {
  const asked: { event: FactoryEvent; answer: FactoryEvent | null }[] = [];
  for (const event of events) {
    if (isQuestion(event)) asked.push({ answer: null, event });
    else if (isAnswer(event)) {
      const last = asked[asked.length - 1];
      if (last && last.answer === null) last.answer = event;
    }
  }
  const last = asked[asked.length - 1];
  if (openQuestion !== null && last && last.event.to === openQuestion) asked.pop();
  return asked
    .map(({ answer, event }): QaEntry => {
      const parsed = parseQuestion(event.to ?? "");
      const given = answer?.to ?? null;
      return {
        answer: given,
        answeredAt: answer?.at ?? null,
        askedBy: askerName(event.actor),
        mark: given === null ? "none" : markOf(parsed.options, given),
        question: parsed.prompt
      };
    })
    .reverse();
}
