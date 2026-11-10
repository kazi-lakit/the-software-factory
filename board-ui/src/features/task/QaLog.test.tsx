import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QaLog } from "./QaLog";
import type { QaEntry } from "./qaEntries";

afterEach(cleanup);

const entry = (over: Partial<QaEntry>): QaEntry => ({ key: String(Math.random()), answer: "A. main", answeredAt: "2026-11-02T10:00:00.000Z", askedBy: "Spec writer", mark: "none", question: "Q?", ...over });

describe("QaLog", () => {
  it("lists_question_answer_time_and_mark_newest_first", () => {
    render(<QaLog entries={[entry({ mark: "recommended", question: "Second?" }), entry({ answer: "use release", mark: "not-recommended", question: "First?" })]} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Second?")).toBeInTheDocument();
    expect(within(items[0]!).getByText("A. main")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Recommended")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Spec writer")).toBeInTheDocument();
    expect(items[0]!.querySelector("time")).toHaveAttribute("dateTime", "2026-11-02T10:00:00.000Z");
    expect(within(items[1]!).getByText("Not recommended")).toBeInTheDocument();
  });

  it("shows_no_mark_for_plain_or_unrecommended_questions", () => {
    render(<QaLog entries={[entry({ mark: "none" })]} />);
    expect(screen.queryByText("Recommended")).toBeNull();
    expect(screen.queryByText("Not recommended")).toBeNull();
  });

  it("shows_no_answer_recorded_for_an_unanswered_question", () => {
    render(<QaLog entries={[entry({ answer: null, answeredAt: null })]} />);
    expect(screen.getByText("No answer recorded")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });

  it("renders_nothing_when_there_are_no_entries", () => {
    const { container } = render(<QaLog entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
