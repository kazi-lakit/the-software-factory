import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EarlierQuestions, QaLog } from "./QaLog";
import type { QaEntry, QaOption } from "./qaEntries";

afterEach(cleanup);

const localIso = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).toISOString();
const NOW = new Date(2026, 10, 11, 12, 0).getTime();

const entry = (over: Partial<QaEntry>): QaEntry => ({
  key: String(Math.random()),
  number: 1,
  question: "Q?",
  askedBy: "Spec writer",
  askedAt: localIso(11, 8, 14),
  stage: "spec",
  options: [],
  answer: "A. main",
  answeredAt: localIso(11, 7, 58),
  resumedAt: null,
  open: false,
  ...over
});

const option = (letter: string, label: string, over: Partial<QaOption> = {}): QaOption => ({ letter, label, why: "why", recommended: false, chosen: false, ...over });
const OPTIONS = [option("A", "main", { recommended: true }), option("B", "develop", { chosen: true })];

const entryItems = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("li.sf-qa-entry")];

describe("QaLog", () => {
  it("panel_has_heading_and_counts", () => {
    render(<QaLog nowMs={NOW} entries={[entry({ answer: null, answeredAt: null, open: true }), entry({})]} />);
    const panel = screen.getByRole("region", { name: "Questions and answers" });
    expect(panel).toHaveClass("sf-panel");
    expect(panel).toHaveTextContent("2 asked · 1 answered");
  });

  it("entries_render_in_the_given_newest_first_order", () => {
    const { container } = render(<QaLog nowMs={NOW} entries={[entry({ question: "Second?" }), entry({ question: "First?" })]} />);
    expect(entryItems(container).map((li) => li.querySelector(".sf-qa-question")?.textContent)).toEqual(["Second?", "First?"]);
  });

  it("open_entry_has_waiting_and_options_chips", () => {
    render(<QaLog nowMs={NOW} entries={[entry({ answer: null, answeredAt: null, open: true, options: [option("A", "main"), option("B", "develop")] })]} />);
    expect(screen.getByText("Waiting for your answer")).toHaveClass("sf-chip", "sf-chip-waiting");
    const offered = screen.getByText("2 options offered");
    expect(offered).toHaveClass("sf-chip");
    expect(offered).not.toHaveClass("sf-chip-waiting");
    expect(screen.queryByText("No answer recorded")).toBeNull();
    cleanup();
    render(<QaLog nowMs={NOW} entries={[entry({ answer: null, answeredAt: null, open: true })]} />);
    expect(screen.getByText("Waiting for your answer")).toBeInTheDocument();
    expect(screen.queryByText(/options offered/)).toBeNull();
  });

  it("open_but_answered_entry_has_no_waiting_chip", () => {
    render(<QaLog nowMs={NOW} entries={[entry({ answer: "B", open: true, options: OPTIONS })]} />);
    expect(screen.queryByText("Waiting for your answer")).toBeNull();
    expect(screen.getByText("Answered by you · today 07:58")).toBeInTheDocument();
  });

  it("entry_shows_label_line_question_and_options_with_marks", () => {
    const { container } = render(<QaLog nowMs={NOW} entries={[entry({ number: 2, question: "Which branch?", answer: "B", options: OPTIONS })]} />);
    const label = screen.getByText("Question 2 · spec writer · spec stage · today 08:14");
    expect(label).toHaveClass("sf-qa-label");
    expect(screen.getByText("Which branch?")).toBeInTheDocument();
    const options = [...container.querySelectorAll<HTMLElement>("li.sf-qa-option")];
    expect(options).toHaveLength(2);
    expect(within(options[0]!).getByText("A. main: why")).toBeInTheDocument();
    expect(within(options[0]!).getByText("Recommended")).toBeInTheDocument();
    expect(within(options[1]!).getByText("B. develop: why")).toBeInTheDocument();
    expect(within(options[1]!).getByText("Your answer")).toBeInTheDocument();
    expect(within(options[0]!).queryByText("Your answer")).toBeNull();
  });

  it("free_text_answer_shows_under_your_answer", () => {
    render(<QaLog nowMs={NOW} entries={[entry({ answer: "use release", options: [option("A", "main"), option("B", "develop")] })]} />);
    const label = screen.getByText("Your answer");
    const answer = screen.getByText("use release");
    expect(label.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("answered_line_with_and_without_resume", () => {
    render(<QaLog nowMs={NOW} entries={[entry({})]} />);
    expect(screen.getByText("Answered by you · today 07:58")).toBeInTheDocument();
    expect(screen.queryByText(/resumed at/)).toBeNull();
    cleanup();
    render(<QaLog nowMs={NOW} entries={[entry({ resumedAt: localIso(11, 7, 59) })]} />);
    expect(screen.getByText("Answered by you · today 07:58 · the spec writer resumed at 07:59")).toBeInTheDocument();
  });

  it("shows_no_answer_recorded_for_an_unanswered_closed_question", () => {
    render(<QaLog nowMs={NOW} entries={[entry({ answer: null, answeredAt: null })]} />);
    expect(screen.getByText("No answer recorded")).toBeInTheDocument();
    expect(screen.queryByText(/Answered by you/)).toBeNull();
  });

  it("renders_nothing_when_there_are_no_entries", () => {
    const { container } = render(<QaLog entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("no_not_recommended_badge", () => {
    render(<QaLog nowMs={NOW} entries={[entry({ answer: "B", options: OPTIONS })]} />);
    expect(screen.queryByText("Not recommended")).toBeNull();
  });
});

describe("EarlierQuestions", () => {
  it("earlier_questions_is_a_closed_disclosure", () => {
    const answered = entry({ answer: "A. main: why", answeredAt: localIso(11, 7, 58), options: [option("A", "main", { chosen: true, recommended: true }), option("B", "develop")], question: "Which branch?" });
    const unanswered = entry({ answer: null, answeredAt: null, question: "Go on?" });
    const { container } = render(<EarlierQuestions nowMs={NOW} entries={[answered, unanswered]} />);
    const details = container.querySelector("details.sf-qa-earlier") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    const summary = details.querySelector("summary");
    expect(summary).toHaveClass("sf-label");
    expect(summary).toHaveTextContent(/^Earlier question \(2\)$/);
    const items = [...details.querySelectorAll("li")];
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Which branch?");
    expect(items[0]).toHaveTextContent("You answered A. main (recommended) at 07:58");
    expect(items[1]).toHaveTextContent("Go on?");
    expect(items[1]).toHaveTextContent("No answer recorded");
  });

  it("no_earlier_entries_render_nothing", () => {
    const { container } = render(<EarlierQuestions nowMs={NOW} entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

it("collapses earlier questions under their question text", () => {
  const { container } = render(<QaLog nowMs={NOW} entries={[entry({ question: "Which branch?", options: OPTIONS })]} />);
  const details = container.querySelector("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(details.querySelector("summary")).toHaveTextContent("Which branch?");
  expect(within(details).getByText("Recommended")).toBeInTheDocument();
});
