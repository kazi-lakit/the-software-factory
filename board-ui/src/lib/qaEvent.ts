import type { FactoryEvent } from "@factory/core";

export const isQuestion = (event: FactoryEvent): boolean => event.field === "question" && event.to !== null;
export const isAnswer = (event: FactoryEvent): boolean => event.field === "answer" && event.reason === "answered" && event.to !== null;

/** A question set, or an answer the owner gave. Other `answer` writes (gate change requests) are not Q and A. */
export const isQaEvent = (event: FactoryEvent): boolean => isQuestion(event) || isAnswer(event);
