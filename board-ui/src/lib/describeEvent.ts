import type { FactoryEvent, Status } from "@factory/core";
import { isAnswer, isQuestion } from "./qaEvent";
import { optionText, parseQuestion } from "../features/task/parseQuestion";
import { STATUS_LABEL } from "../features/board/status";

/** A piece of a change sentence: plain text, or a status shown as a chip. */
export type ChangePart = string | { status: Status; label: string };

/** What an event alone does not say: the doc version a written move made, the question an answer replied to. */
export type DescribeContext = { docVersion?: number; question?: string | null };

export type Description = { text: string; parts: ChangePart[] };

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const isStatus = (value: string | null): value is Status => value !== null && Object.prototype.hasOwnProperty.call(STATUS_LABEL, value);

const APPROVAL = /^(\w+):(approve|changes)@v(\d+)$/;

function done(parts: ChangePart[]): Description {
  return { parts, text: parts.map((part) => (typeof part === "string" ? part : part.label)).join("") };
}

function writtenKind(event: FactoryEvent): "spec" | "plan" | undefined {
  if (event.field !== "status") return undefined;
  if (event.reason.startsWith("spec written")) return "spec";
  if (event.reason.startsWith("plan written")) return "plan";
  return undefined;
}

function fallback(event: FactoryEvent): Description {
  const value = (v: string | null) => (v === null ? "—" : collapse(v));
  return done([`${event.field ?? event.action}: `, value(event.from), " → ", value(event.to)]);
}

/** A change as a human sentence. Pure: no React, no I/O. */
export function describeEvent(event: FactoryEvent, context: DescribeContext = {}): Description {
  if (event.action === "create") return done([`Created in ${event.to ?? "inbox"}`]);

  if (event.field === "status") {
    const kind = writtenKind(event);
    if (kind) {
      const name = kind === "spec" ? "Spec" : "Plan";
      return done([context.docVersion === undefined ? `${name} written` : `${name} v${context.docVersion} written`]);
    }
    if (event.to === "ready" && event.reason === "marked ready") return done(["Marked ready"]);
    if (event.to === "cancelled") return done(["Cancelled"]);
    if (isStatus(event.to)) return done([`status ${event.from ?? "—"} → `, { label: STATUS_LABEL[event.to], status: event.to }]);
    return fallback(event);
  }

  if (event.field === "approval") {
    const match = APPROVAL.exec(event.to ?? "");
    if (match) return done([`${match[2] === "changes" ? "Requested changes on" : "Approved"} ${match[1]} v${match[3]}`]);
    return fallback(event);
  }

  if (isQuestion(event)) {
    const text = event.to!;
    const first = collapse(text.split("\n").find((line) => line.trim() !== "") ?? "");
    const count = parseQuestion(text).options.length;
    return done(["Asked: \"", first, count > 0 ? `" · ${count} options` : "\""]);
  }

  if (isAnswer(event)) {
    const answer = collapse(event.to!);
    const parsed = context.question ? parseQuestion(context.question) : undefined;
    const prompt = parsed ? collapse(parsed.prompt) : "";
    if (!parsed || prompt === "") return done(["Answered with ", answer]);
    const marked = parsed.options.filter((option) => option.recommended);
    const recommended = marked.length === 1 && answer === collapse(optionText(marked[0]!));
    return done(["Answered \"", prompt, "\" with ", answer, ...(recommended ? [", the recommended answer"] : [])]);
  }

  if (event.field === "dependsOn") {
    try {
      const list: unknown = JSON.parse(event.to ?? "");
      if (Array.isArray(list)) return done([list.length === 0 ? "Waits for no tasks" : `Waits for ${list.map(String).join(", ")}`]);
    } catch {
      // Not a JSON list: shown as a plain change below.
    }
    return fallback(event);
  }

  const field = event.field ?? "";
  const segments = field.split(".");
  const key =
    segments[0] === "settings" || segments[0] === "repo" ? segments.slice(2).join(".") :
    segments[0] === "def" ? segments.slice(1).join(".") : "";
  if (key !== "") return done([`${key} set to `, event.to === null ? "—" : collapse(event.to)]);

  return fallback(event);
}

/**
 * The context of each event that needs one, from the same task's earlier events. `events` are newest first.
 * A spec or plan written move gets its version (the count of such moves of that kind so far); an answer gets
 * the latest question set before it, or null when that question was cleared.
 */
export function eventContexts(events: readonly FactoryEvent[]): Map<FactoryEvent, DescribeContext> {
  const contexts = new Map<FactoryEvent, DescribeContext>();
  const counts = new Map<string, { spec: number; plan: number }>();
  const questions = new Map<string, string | null>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.field === "question") {
      questions.set(event.taskId, event.to);
      continue;
    }
    const kind = writtenKind(event);
    if (kind) {
      const count = counts.get(event.taskId) ?? { plan: 0, spec: 0 };
      count[kind] += 1;
      counts.set(event.taskId, count);
      contexts.set(event, { docVersion: count[kind] });
    } else if (isAnswer(event)) {
      contexts.set(event, { question: questions.get(event.taskId) ?? null });
    }
  }
  return contexts;
}
