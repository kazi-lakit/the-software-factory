import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@factory/core";
import { TaskCard } from "./TaskCard";
import { STATUS_LABEL } from "./status";

function task(patch: Partial<Task> = {}): Task {
  return {
    answer: null, attempt: 0, baseBranch: "dev", blockedReason: null, branch: null, claimBy: null, claimUntil: null, costUsd: 0,
    description: "", factoryId: "blocks", gateOverrides: {}, dependsOn: [], prUrl: null, question: null, repo: "data", stage: null, status: "inbox",
    taskId: "T-7", title: "Add a filter", version: 1, ...patch
  };
}

afterEach(cleanup);

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

  it("shows_the_repo_and_no_age_or_stage_text", () => {
    render(<TaskCard task={task({ stage: "build", status: "build" })} onNavigate={vi.fn()} />);
    expect(screen.getByText("data")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ago|\d+\s?[mhd]\b|Stage:|Waiting for you/);
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

  it.each([["spec_review", 0], ["plan_review", 1], ["pr_open", 5]] as const)("%s_draws_its_step_in_the_accent", (status, index) => {
    render(<TaskCard task={task({ status })} onNavigate={vi.fn()} />);
    expect(states()[index]).toBe("waiting");
  });

  it("inbox_and_ready_draw_no_finished_current_or_accent_segment", () => {
    for (const status of ["inbox", "ready"] as const) {
      render(<TaskCard task={task({ status })} onNavigate={vi.fn()} />);
      expect(states()).toEqual(Array(6).fill("todo"));
      cleanup();
    }
  });

  it("blocked_with_a_null_stage_draws_no_accent_segment", () => {
    render(<TaskCard task={task({ stage: null, status: "blocked" })} onNavigate={vi.fn()} />);
    expect(states()).not.toContain("waiting");
  });

  it("done_draws_all_six_finished", () => {
    render(<TaskCard task={task({ status: "done" })} onNavigate={vi.fn()} />);
    expect(states()).toEqual(Array(6).fill("done"));
  });

  it("shows_the_first_line_of_a_blocked_question", () => {
    render(<TaskCard task={task({ question: "Which base branch?\nThe repo has dev and stg.", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(screen.getByText("Which base branch?")).toHaveClass("sf-card-question");
    expect(screen.queryByText(/The repo has dev and stg/)).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: label })).toHaveClass("sf-card-cta");
    expect(document.querySelectorAll(".sf-card-cta")).toHaveLength(1);
    expect(screen.getByRole("article")).toHaveClass("sf-card-needs-you");
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
    expect(screen.getByText("Waiting on T-3, T-4")).toBeInTheDocument();
  });

  it("shows_no_waiting_badge_without_dependencies", () => {
    render(<TaskCard task={task({ status: "ready" })} onNavigate={vi.fn()} />);
    expect(screen.queryByText(/Waiting on/)).not.toBeInTheDocument();
  });
});
