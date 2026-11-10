import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionConflictError, type FactoryEvent, type Task } from "@factory/core";
import { clearAllUnsent } from "../../lib/unsent";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { AnswerPanel } from "./AnswerPanel";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const answerBox = () => screen.getByLabelText("Your answer");
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
const answerOf = async (task: Task) => (await fakeBoard().owner.getTask(task.taskId)).answer;

const SPEC_WRITER = "spec-writer · sdk · run R-1";
const LETTERED = (recommended: boolean) =>
  `Which branch?\nA. main: fits the others${recommended ? " (recommended)" : ""}\nB. develop: more work\nReply with an option letter, or answer in your own words.`;

function questionEvent(task: Task, actor = SPEC_WRITER): FactoryEvent {
  return { action: "set", actor, at: "2026-11-01T10:00:00.000Z", factoryId: task.factoryId, field: "question", from: null, reason: "asked", taskId: task.taskId, to: task.question };
}

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  clearAllUnsent();
  vi.restoreAllMocks();
});

async function blockedTask(question = "Which base branch?\nThe repo has dev and stg.") {
  return seedTask({ title: "Stuck" }, "blocked", { blockedReason: "agent asked", question, stage: "spec" });
}

async function renderPanel(question?: string, actor?: string) {
  const task = await blockedTask(question);
  renderWithClient(<AnswerPanel task={task} events={[questionEvent(task, actor)]} onReload={vi.fn()} />);
  return task;
}

describe("AnswerPanel layout", () => {
  it("shows_the_question_as_a_heading_with_who_asks", async () => {
    await renderPanel(LETTERED(true));
    const heading = screen.getByRole("heading", { name: "Which branch?" });
    expect(heading.tagName).toBe("H3");
    expect(heading).toHaveClass("sf-question-title");
    expect(screen.getByText("Spec writer")).toBeInTheDocument();
    expect(screen.getByText("agent asked")).toBeInTheDocument();
  });

  it("an_unusual_actor_is_humanised_and_a_missing_one_shows_no_asker", async () => {
    await renderPanel("Continue?", "core · loop");
    expect(screen.getByText("Factory")).toBeInTheDocument();
    cleanup();
    const task = await blockedTask("Continue?");
    renderWithClient(<AnswerPanel task={task} events={[]} onReload={vi.fn()} />);
    expect(screen.queryByTestId("asker")).toBeNull();
  });

  it("renders_each_option_as_a_radio_card_with_label_and_why", async () => {
    await renderPanel(LETTERED(true));
    const group = screen.getByRole("radiogroup", { name: "Which branch?" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("fits the others")).toBeInTheDocument();
    expect(screen.getByText("fits the others")).toHaveClass("sf-radio-why");
    expect(screen.getByText("develop")).toBeInTheDocument();
  });

  it("recommended_option_has_the_chip_and_is_preselected", async () => {
    await renderPanel(LETTERED(true));
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    const [a, b] = screen.getAllByRole("radio");
    expect(a).toBeChecked();
    expect(b).not.toBeChecked();
    expect(a!.closest("label")).toContainElement(screen.getByText("Recommended"));
  });

  it("no_chip_and_nothing_selected_without_a_recommendation", async () => {
    await renderPanel(LETTERED(false));
    expect(screen.queryByText("Recommended")).toBeNull();
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("plain_text_question_shows_only_the_heading_and_textarea", async () => {
    await renderPanel("Should I continue?");
    expect(screen.getByRole("heading", { name: "Should I continue?" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("Recommended")).toBeNull();
    expect(answerBox()).toBeInTheDocument();
  });

  it("more_than_four_options_falls_back_to_plain_layout", async () => {
    await renderPanel("Q?\nA. a: x\nB. b: x\nC. c: x\nD. d: x\nE. e: x");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(answerBox()).toBeInTheDocument();
  });

  it("choosing_other_opens_a_textarea_and_other_is_last", async () => {
    await renderPanel(LETTERED(true));
    expect(screen.queryByLabelText("Your answer")).toBeNull();
    const radios = screen.getAllByRole("radio");
    expect(radios[radios.length - 1]).toHaveAccessibleName(/Other/);
    fireEvent.click(radios[radios.length - 1]!);
    expect(answerBox()).toBeInTheDocument();
    expect(answerBox()).toHaveClass("sf-input");
  });

  it("radios_share_a_name_so_arrow_keys_move_the_selection", async () => {
    await renderPanel(LETTERED(true));
    const names = new Set(screen.getAllByRole("radio").map((r) => r.getAttribute("name")));
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();
  });

  it("send_answer_uses_the_accent_fill", async () => {
    await renderPanel();
    const button = screen.getByRole("button", { name: "Send answer" });
    expect(button).toHaveClass("sf-button-accent");
    expect(button).not.toHaveClass("sf-button-primary");
  });

  it("answer_panel_is_a_needs_you_panel", async () => {
    await renderPanel();
    expect(screen.getByRole("region")).toHaveClass("sf-panel", "sf-panel-needs-you");
  });
});

describe("AnswerPanel sending", () => {
  it("sends_the_preselected_option_text_with_the_version", async () => {
    const task = await renderPanel(LETTERED(true));
    send();
    expect(await screen.findByText(/Answer sent/)).toBeInTheDocument();
    expect(await answerOf(task)).toBe("A. main: fits the others");
  });

  it("sends_another_picked_option", async () => {
    const task = await renderPanel(LETTERED(true));
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    send();
    expect(await screen.findByText(/Answer sent/)).toBeInTheDocument();
    expect(await answerOf(task)).toBe("B. develop: more work");
  });

  it("sends_the_trimmed_other_text", async () => {
    const task = await renderPanel(LETTERED(true));
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[radios.length - 1]!);
    fireEvent.change(answerBox(), { target: { value: "  use release  " } });
    send();
    expect(await screen.findByText(/Answer sent/)).toBeInTheDocument();
    expect(await answerOf(task)).toBe("use release");
  });

  it("sends_the_plain_text_answer_and_clears_the_draft", async () => {
    const task = await renderPanel();
    fireEvent.change(answerBox(), { target: { value: "Use dev." } });
    send();
    expect(await screen.findByText(/Answer sent/)).toBeInTheDocument();
    expect(await answerOf(task)).toBe("Use dev.");
    expect(answerBox()).toHaveValue("");
  });

  it("refuses_with_nothing_selected", async () => {
    const task = await renderPanel(LETTERED(false));
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("Write an answer first.");
    expect(await answerOf(task)).toBeNull();
  });

  it("refuses_blank_other_text", async () => {
    const task = await renderPanel(LETTERED(true));
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[radios.length - 1]!);
    fireEvent.change(answerBox(), { target: { value: "   " } });
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("Write an answer first.");
    expect(await answerOf(task)).toBeNull();
  });

  it("needs_non_blank_plain_text", async () => {
    const task = await renderPanel();
    fireEvent.change(answerBox(), { target: { value: "   " } });
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("Write an answer first.");
    expect(await answerOf(task)).toBeNull();
  });

  it("disables_send_while_sending", async () => {
    const task = await blockedTask(LETTERED(true));
    let release: () => void = () => undefined;
    const pending = new Promise<never>((_, reject) => {
      release = () => reject(new Error("stop"));
    });
    const spy = vi.spyOn(fakeBoard().owner, "updateTask").mockReturnValueOnce(pending);
    renderWithClient(<AnswerPanel task={task} events={[questionEvent(task)]} onReload={vi.fn()} />);
    send();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled());
    send();
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send answer" })).toBeEnabled());
  });

  it("passes_the_version_it_rendered_and_refuses_a_question_that_moved_on", async () => {
    const task = await blockedTask();
    await fakeBoard().core.updateTask(task.taskId, task.version, { question: "A newer question?" });
    renderWithClient(<AnswerPanel task={task} events={[]} onReload={vi.fn()} />);
    fireEvent.change(answerBox(), { target: { value: "Use dev." } });
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("This task changed while you were looking. Reload to see the latest.");
    expect(await answerOf(task)).toBeNull();
    expect(answerBox()).toHaveValue("Use dev.");
  });

  it("keeps_selection_and_text_on_a_conflict", async () => {
    const task = await blockedTask(LETTERED(true));
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new VersionConflictError(task.taskId, task.version, task.version + 1));
    renderWithClient(<AnswerPanel task={task} events={[questionEvent(task)]} onReload={vi.fn()} />);
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[radios.length - 1]!);
    fireEvent.change(answerBox(), { target: { value: "use release" } });
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("This task changed while you were looking. Reload to see the latest.");
    expect(screen.queryByText(/Answer sent/)).toBeNull();
    expect(screen.getAllByRole("radio")[2]).toBeChecked();
    expect(answerBox()).toHaveValue("use release");
  });
});
