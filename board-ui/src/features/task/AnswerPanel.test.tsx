import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionConflictError } from "@factory/core";
import { clearAllUnsent } from "../../lib/unsent";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { AnswerPanel } from "./AnswerPanel";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const answerBox = () => screen.getByLabelText("Your answer");

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  clearAllUnsent();
  vi.restoreAllMocks();
});

async function blockedTask() {
  return seedTask({ title: "Stuck" }, "blocked", { blockedReason: "agent asked", question: "Which base branch?\nThe repo has dev and stg.", stage: "spec" });
}

describe("AnswerPanel", () => {
  it("shows_the_whole_question_and_the_reason", async () => {
    const task = await blockedTask();
    renderWithClient(<AnswerPanel task={task} onReload={vi.fn()} />);
    expect(screen.getByText(/The repo has dev and stg\./)).toBeInTheDocument();
    expect(screen.getByText("agent asked")).toBeInTheDocument();
  });

  it("send_answer_uses_the_accent_fill", async () => {
    const task = await blockedTask();
    renderWithClient(<AnswerPanel task={task} onReload={vi.fn()} />);
    const send = screen.getByRole("button", { name: "Send answer" });
    expect(send).toHaveClass("sf-button-accent");
    expect(send).not.toHaveClass("sf-button-primary");
  });

  it("needs_non_blank_text", async () => {
    const task = await blockedTask();
    renderWithClient(<AnswerPanel task={task} onReload={vi.fn()} />);
    fireEvent.change(answerBox(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Write an answer first.");
    expect((await fakeBoard().owner.getTask(task.taskId)).answer).toBeNull();
  });

  it("sends_the_answer", async () => {
    const task = await blockedTask();
    renderWithClient(<AnswerPanel task={task} onReload={vi.fn()} />);
    fireEvent.change(answerBox(), { target: { value: "Use dev." } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByText(/Answer sent/)).toBeInTheDocument();
    expect((await fakeBoard().owner.getTask(task.taskId)).answer).toBe("Use dev.");
    expect(answerBox()).toHaveValue("");
  });

  it("passes_the_version_it_rendered_and_refuses_a_question_that_moved_on", async () => {
    const task = await blockedTask();
    // The task changes after the panel rendered (e.g. the engine asked a new question).
    await fakeBoard().core.updateTask(task.taskId, task.version, { question: "A newer question?" });
    renderWithClient(<AnswerPanel task={task} onReload={vi.fn()} />);
    fireEvent.change(answerBox(), { target: { value: "Use dev." } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This task changed while you were looking. Reload to see the latest.");
    expect((await fakeBoard().owner.getTask(task.taskId)).answer).toBeNull();
    expect(answerBox()).toHaveValue("Use dev.");
  });

  it("keeps_the_answer_on_a_conflict", async () => {
    const task = await blockedTask();
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new VersionConflictError(task.taskId, task.version, task.version + 1));
    renderWithClient(<AnswerPanel task={task} onReload={vi.fn()} />);
    fireEvent.change(answerBox(), { target: { value: "Use dev." } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This task changed while you were looking. Reload to see the latest.");
    expect(answerBox()).toHaveValue("Use dev.");
  });
});

describe("AnswerPanel styling", () => {
  it("answer_panel_is_a_needs_you_panel", async () => {
    const task = await blockedTask();
    renderWithClient(<AnswerPanel task={task} onReload={vi.fn()} />);
    expect(screen.getByRole("region")).toHaveClass("sf-panel", "sf-panel-needs-you");
  });
});
