import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, type Task } from "@factory/core";
import { fakeBoard, renderWithClient, resetFakeBoard, seedTask } from "../../test/fakeBoard";
import { atPhoneWidth, BOARD_CSS, renderedClasses, tooWide } from "../../test/phoneWidth";
import { TaskCard } from "./TaskCard";
import { STATUS_LABEL } from "./status";
import { BOARD_KEY } from "./useBoard";

vi.mock("../../lib/board", async () => ({ boardStore: (await import("../../test/fakeBoard")).proxyBoardStore }));

const render = renderWithClient;

function task(patch: Partial<Task> = {}): Task {
  return {
    answer: null, attempt: 0, baseBranch: "dev", blockedReason: null, branch: null, claimBy: null, claimUntil: null, costUsd: 0,
    description: "", factoryId: "blocks", gateOverrides: {}, dependsOn: [], prUrl: null, question: null, repo: "data", stage: null, status: "inbox",
    taskId: "T-7", title: "Add a filter", version: 1, ...patch
  };
}

beforeEach(() => {
  resetFakeBoard();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ALL = ["inbox", "ready", "spec", "spec_review", "plan", "plan_review", "build", "verify", "review", "pr_open", "done", "blocked", "cancelled"] as const;
const states = () => Array.from(document.querySelectorAll(".sf-step")).map((el) => el.getAttribute("data-state"));

describe("TaskCard", () => {
  it("top_row_shows_id_left_and_status_chip_right", () => {
    render(<TaskCard task={task({ status: "spec_review" })} onNavigate={vi.fn()} />);
    const top = document.querySelector(".sf-card-top")!;
    const id = screen.getByText("T-7");
    const chip = screen.getByText("Spec review");
    expect(id).toHaveClass("sf-mono");
    expect(chip).toHaveClass("sf-card-status");
    expect(top.firstElementChild).toBe(id);
    expect(top.lastElementChild).toBe(chip);
  });

  it.each(ALL)("chip_shows_the_status_label_for_%s", (status) => {
    render(<TaskCard task={task({ status })} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-status")).toHaveTextContent(STATUS_LABEL[status]);
  });

  it("lanes_chip_says_question_for_a_blocked_task_with_a_question", () => {
    render(<TaskCard task={task({ question: "Which branch?", status: "blocked" })} view="lanes" onNavigate={vi.fn()} />);
    const chip = document.querySelector(".sf-card-status");
    expect(chip).toHaveTextContent(/^Question$/);
    expect(chip).toHaveClass("sf-card-status-waiting");
  });

  it("lanes_chip_says_blocked_when_the_question_is_blank", () => {
    render(<TaskCard task={task({ question: "  ", status: "blocked" })} view="lanes" onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-status")).toHaveTextContent(/^Blocked$/);
  });

  it("default_view_is_lanes", () => {
    render(<TaskCard task={task({ question: "Which branch?", stage: "build", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-status")).toHaveTextContent(/^Question$/);
    expect(document.querySelector(".sf-steps")).not.toBeNull();
  });

  it.each(["spec_review", "plan_review", "pr_open", "blocked"] as const)("stages_chip_says_waiting_for_you_on_%s", (status) => {
    render(<TaskCard task={task({ question: "Which branch?", status })} view="stages" onNavigate={vi.fn()} />);
    const chips = document.querySelectorAll(".sf-card-status");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent(/^Waiting for you$/);
    expect(chips[0]).toHaveClass("sf-card-status-waiting");
  });

  it.each(["inbox", "ready", "spec", "plan", "build", "verify", "review", "done", "cancelled"] as const)("stages_cards_that_do_not_wait_have_no_chip_%s", (status) => {
    render(<TaskCard task={task({ status })} view="stages" onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-status")).toBeNull();
    expect(document.querySelector(".sf-card-top")).toHaveTextContent("T-7");
  });

  it("step_bar_shows_in_lanes_for_a_task_with_a_stage", () => {
    render(<TaskCard task={task({ stage: "build", status: "build" })} view="lanes" onNavigate={vi.fn()} />);
    expect(document.querySelectorAll(".sf-steps")).toHaveLength(1);
  });

  it("no_step_bar_in_lanes_when_the_stage_is_null", () => {
    render(<TaskCard task={task({ stage: null, status: "inbox" })} view="lanes" onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-steps")).toBeNull();
    expect(screen.getByText("data")).toBeInTheDocument();
  });

  it("no_step_bar_in_all_stages", () => {
    render(<TaskCard task={task({ stage: "build", status: "build" })} view="stages" onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-steps")).toBeNull();
    expect(screen.getByText("data")).toBeInTheDocument();
  });

  it("shows_the_repo_and_no_age_or_stage_text", () => {
    render(<TaskCard task={task({ costUsd: 1.5, stage: "build", status: "build" })} onNavigate={vi.fn()} />);
    expect(screen.getByText("data")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ago|\d+\s?[mhd]\b|Stage:|Waiting for you/);
    expect(document.querySelector(".sf-card-meta")?.textContent).not.toMatch(/\$|ago|\d+\s?[mhd]\b/);
  });

  it("title_is_a_link_to_the_task_path", () => {
    render(<TaskCard task={task()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Add a filter" })).toHaveAttribute("href", "/tasks/T-7");
  });

  it("opens_the_task_in_the_app", () => {
    const onNavigate = vi.fn();
    render(<TaskCard task={task()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "Add a filter" }));
    expect(onNavigate).toHaveBeenCalledWith("/tasks/T-7");
  });

  it("a_modified_click_on_the_title_is_left_to_the_browser", () => {
    const onNavigate = vi.fn();
    render(<TaskCard task={task()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "Add a filter" }), { ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("progress_bar_has_six_segments_with_an_accessible_name", () => {
    render(<TaskCard task={task({ stage: "build", status: "build" })} onNavigate={vi.fn()} />);
    const bar = screen.getByRole("img", { name: "Progress: Build, step 3 of 6" });
    const steps = Array.from(bar.querySelectorAll(".sf-step"));
    expect(steps.map((el) => el.getAttribute("title"))).toEqual(["Spec", "Plan", "Build", "Verify", "Review", "PR"]);
  });

  it("build_task_draws_earlier_steps_done_and_build_current", () => {
    render(<TaskCard task={task({ stage: "build", status: "build" })} onNavigate={vi.fn()} />);
    expect(states()).toEqual(["done", "done", "current", "todo", "todo", "todo"]);
  });

  it.each([["spec_review", "spec", 0], ["plan_review", "plan", 1], ["pr_open", "ship", 5]] as const)("%s_draws_its_step_in_the_accent", (status, stage, index) => {
    render(<TaskCard task={task({ stage, status })} onNavigate={vi.fn()} />);
    expect(states()[index]).toBe("waiting");
  });

  it("inbox_and_ready_with_a_null_stage_draw_no_step_bar", () => {
    for (const status of ["inbox", "ready"] as const) {
      render(<TaskCard task={task({ stage: null, status })} onNavigate={vi.fn()} />);
      expect(document.querySelector(".sf-steps")).toBeNull();
      cleanup();
    }
  });

  it("blocked_with_a_null_stage_draws_no_step_bar", () => {
    render(<TaskCard task={task({ stage: null, status: "blocked" })} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-steps")).toBeNull();
  });

  it("done_draws_all_six_finished", () => {
    render(<TaskCard task={task({ stage: "ship", status: "done" })} onNavigate={vi.fn()} />);
    expect(states()).toEqual(Array(6).fill("done"));
  });

  it("shows_the_first_line_of_a_blocked_question", () => {
    render(<TaskCard task={task({ question: "Which base branch?\nThe repo has dev and stg.", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(screen.getByText("Which base branch?")).toHaveClass("sf-card-question-text");
    expect(screen.getByText("Which base branch?").parentElement).toHaveClass("sf-card-question");
    expect(screen.queryByText(/The repo has dev and stg/)).not.toBeInTheDocument();
  });

  it("blocked_card_question_line_ends_with_option_count", () => {
    render(<TaskCard task={task({ question: "Which base?\nA. dev: x (recommended)\nB. stg: y\nC. main: z", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-question")).toHaveTextContent(/^Which base\? · 3 options$/);
    expect(document.querySelector(".sf-card-question-options")?.textContent).toBe(" · 3 options");
    const line = document.querySelector(".sf-card-question");
    expect([...(line?.children ?? [])].map((c) => c.className)).toEqual(["sf-card-question-text", "sf-card-question-options"]);
    expect(line?.querySelector(".sf-card-question-text")?.textContent).toBe("Which base?");
  });

  it("card_question_without_options_has_no_suffix", () => {
    render(<TaskCard task={task({ question: "Which base?", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-question")?.textContent).toBe("Which base?");
    expect(document.querySelector(".sf-card-question-options")).toBeNull();
  });

  it("a_blank_first_line_shows_no_question_box", () => {
    render(<TaskCard task={task({ question: "  \n x", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-question")).toBeNull();
  });

  it("a_question_on_a_non_blocked_task_is_not_shown", () => {
    render(<TaskCard task={task({ question: "Which?", status: "build" })} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-question")).toBeNull();
  });

  it.each([
    ["spec_review", null, "Review the spec"],
    ["plan_review", null, "Review the plan"],
    ["pr_open", null, "Review the PR"],
    ["blocked", "Which branch?", "Answer the question"],
    ["blocked", null, "See why it stopped"]
  ] as const)("shows_the_cta_for_%s_%s", (status, question, label) => {
    render(<TaskCard task={task({ question, status })} onNavigate={vi.fn()} />);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", "/tasks/T-7");
    expect(screen.getByRole("link", { name: label })).toHaveClass("sf-button", "sf-button-small", "sf-card-cta");
    expect(document.querySelectorAll(".sf-card-cta")).toHaveLength(1);
    expect(screen.getByRole("article")).toHaveClass("sf-card-needs-you");
  });

  it.each([2, 3, 4])("answer_label_counts_lettered_options_%i", (n) => {
    const options = Array.from({ length: n }, (_, i) => `${String.fromCharCode(65 + i)}. opt: why`);
    const question = ["Which base?", ...options, "Reply with an option letter, or answer in your own words."].join("\n");
    render(<TaskCard task={task({ question, status: "blocked" })} onNavigate={vi.fn()} />);
    expect(screen.getByRole("link", { name: `Answer (${n} options)` })).toHaveAttribute("href", "/tasks/T-7");
  });

  it("a_single_or_malformed_option_list_keeps_answer_the_question", () => {
    render(<TaskCard task={task({ question: "Q?\nA. only one", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Answer the question" })).toBeInTheDocument();
  });

  it("non_waiting_cards_have_no_cta_and_the_standard_border", () => {
    for (const status of ["inbox", "ready", "spec", "plan", "build", "verify", "review", "done", "cancelled"] as const) {
      render(<TaskCard task={task({ question: "Q?", status })} onNavigate={vi.fn()} />);
      expect(document.querySelector(".sf-card-cta")).toBeNull();
      expect(screen.getByRole("article")).not.toHaveClass("sf-card-needs-you");
      cleanup();
    }
  });

  it.each(["done", "cancelled"] as const)("%s_cards_use_the_muted_class", (status) => {
    render(<TaskCard task={task({ status })} onNavigate={vi.fn()} />);
    expect(screen.getByRole("article")).toHaveClass("sf-card-muted");
  });

  it("the_cta_click_navigates_in_app_once", () => {
    const onNavigate = vi.fn();
    render(<TaskCard task={task({ status: "spec_review" })} onNavigate={onNavigate} />);
    const cta = screen.getByRole("link", { name: "Review the spec" });
    fireEvent.click(cta);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("/tasks/T-7");
    fireEvent.click(cta, { ctrlKey: true });
    fireEvent.click(cta, { button: 1 });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("the_cta_is_a_tab_stop_separate_from_the_title_link", () => {
    render(<TaskCard task={task({ status: "spec_review" })} onNavigate={vi.fn()} />);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Review the spec" })).not.toHaveAttribute("tabindex", "-1");
  });
});

describe("TaskCard factory tag", () => {
  it("tags_the_id_with_the_factory_only_when_asked", () => {
    render(<TaskCard task={task({ factoryId: "delta" })} showFactory onNavigate={vi.fn()} />);
    expect(screen.getByText("delta · T-7")).toBeInTheDocument();
    cleanup();
    render(<TaskCard task={task({ factoryId: "delta" })} onNavigate={vi.fn()} />);
    expect(screen.getByText("T-7")).toBeInTheDocument();
  });

  it("shows_what_a_task_is_waiting_on", () => {
    render(<TaskCard task={task({ status: "ready" })} waitingOn={["T-3", "T-4"]} onNavigate={vi.fn()} />);
    expect(document.querySelector(".sf-card-waiting")).toHaveTextContent(/^Waiting on T-3, T-4$/);
  });

  it("waiting_on_ids_are_links_to_the_tasks", () => {
    render(<TaskCard task={task({ status: "ready" })} waitingOn={["T-3", "T-4"]} onNavigate={vi.fn()} />);
    expect(screen.getByRole("link", { name: "T-3" })).toHaveAttribute("href", "/tasks/T-3");
    expect(screen.getByRole("link", { name: "T-4" })).toHaveAttribute("href", "/tasks/T-4");
  });

  it("a_waiting_on_link_navigates_in_app", () => {
    const onNavigate = vi.fn();
    render(<TaskCard task={task({ status: "ready" })} waitingOn={["T-3"]} onNavigate={onNavigate} />);
    const link = screen.getByRole("link", { name: "T-3" });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("/tasks/T-3");
    fireEvent.click(link, { ctrlKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("shows_no_waiting_badge_without_dependencies", () => {
    render(<TaskCard task={task({ status: "ready" })} onNavigate={vi.fn()} />);
    expect(screen.queryByText(/Waiting on/)).not.toBeInTheDocument();
  });
});

describe("TaskCard Mark ready", () => {
  it("inbox_card_has_a_small_mark_ready_button", async () => {
    const seeded = await seedTask();
    render(<TaskCard task={seeded} onNavigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Mark ready" })).toHaveClass("sf-button", "sf-button-small", "sf-card-ready");
  });

  it("only_inbox_cards_have_mark_ready", () => {
    for (const status of ALL.filter((s) => s !== "inbox")) {
      render(<TaskCard task={task({ status })} onNavigate={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Mark ready" }), status).toBeNull();
      cleanup();
    }
  });

  it("mark_ready_calls_markReady_and_refreshes_the_board", async () => {
    const seeded = await seedTask();
    const { client } = render(<TaskCard task={seeded} onNavigate={vi.fn()} />);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    await waitFor(async () => expect((await fakeBoard().owner.getTask(seeded.taskId)).status).toBe("ready"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: BOARD_KEY }));
  });

  it("mark_ready_failure_shows_the_write_error_inline", async () => {
    const seeded = await seedTask();
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new ForbiddenError("refused"));
    render(<TaskCard task={seeded} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Blocks refused this change for your account.");
    expect(alert).toHaveClass("sf-card-error");
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark ready" })).not.toBeDisabled());
  });

  it("a_new_attempt_clears_the_error", async () => {
    const seeded = await seedTask();
    vi.spyOn(fakeBoard().owner, "updateTask").mockRejectedValueOnce(new ForbiddenError("refused"));
    render(<TaskCard task={seeded} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark ready" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("TaskCard at 360px", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = atPhoneWidth();
  });
  afterEach(() => restore());

  it("card_fits_360_with_option_count", () => {
    const { container } = render(<TaskCard task={task({ question: "Which base?\nA. dev: x (recommended)\nB. stg: y\nC. main: z", stage: "build", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(tooWide(BOARD_CSS, renderedClasses(container, BOARD_CSS))).toEqual([]);
    expect(container.querySelector(".sf-card-question-options")?.textContent).toBe(" · 3 options");
  });
});
