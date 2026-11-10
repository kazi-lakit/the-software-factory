import type { FactoryEvent } from "@factory/core";
import { isAnswer, isQuestion } from "../../lib/qaEvent";
import { optionText, parseQuestion } from "./parseQuestion";

export type QaMark = "recommended" | "not-recommended" | "none";
export type QaEntry = { key: string; question: string; askedBy: string; answer: string | null; answeredAt: string | null; mark: QaMark };

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
  const marked = options.filter((option) => option.recommended);
  if (marked.length !== 1) return "none";
  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
  return collapse(answer) === collapse(optionText(marked[0]!)) ? "recommended" : "not-recommended";
}

/**
 * The earlier questions with their answers, newest first. `events` are oldest first. An answer pairs with the
 * latest question before it; while a question is open (`openQuestion`) the latest question event, the one that set it, is left out.
 */
export function buildQaLog(events: readonly FactoryEvent[], openQuestion: string | null): QaEntry[] {
  const asked: { event: FactoryEvent; answer: FactoryEvent | null }[] = [];
  let cleared = false;
  for (const event of events) {
    if (isQuestion(event)) {
      asked.push({ answer: null, event });
      cleared = false;
    } else if (event.field === "question") cleared = true;
    else if (isAnswer(event) && !cleared) {
      const last = asked[asked.length - 1];
      if (last && last.answer === null) last.answer = event;
    }
  }
  const latest = asked[asked.length - 1];
  if (openQuestion !== null && latest && (latest.event.to ?? "").trim() === openQuestion.trim()) asked.pop();
  return asked
    .map(({ answer, event }, index): QaEntry => {
      const parsed = parseQuestion(event.to ?? "");
      const given = answer?.to ?? null;
      return {
        answer: given,
        answeredAt: answer?.at ?? null,
        key: `${index}:${event.at}`,
        askedBy: askerName(event.actor),
        mark: given === null ? "none" : markOf(parsed.options, given),
        question: parsed.prompt || "Choose an answer"
      };
    })
    .reverse();
}
