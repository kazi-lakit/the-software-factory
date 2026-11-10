import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@factory/core";
import { TaskCard } from "./TaskCard";

function task(patch: Partial<Task> = {}): Task {
  return {
    answer: null, attempt: 0, baseBranch: "dev", blockedReason: null, branch: null, claimBy: null, claimUntil: null, costUsd: 0,
    description: "", factoryId: "blocks", gateOverrides: {}, prUrl: null, question: null, repo: "data", stage: null, status: "inbox",
    taskId: "T-7", title: "Add a filter", version: 1, ...patch
  };
}

afterEach(cleanup);

describe("TaskCard", () => {
  it("shows_the_id_title_repo_and_stage", () => {
    render(<TaskCard task={task({ stage: "build", status: "build" })} onNavigate={vi.fn()} />);
    expect(screen.getByText("T-7")).toHaveClass("sf-mono");
    expect(screen.getByRole("link", { name: "Add a filter" })).toHaveAttribute("href", "/tasks/T-7");
    expect(screen.getByText("data")).toBeInTheDocument();
    expect(screen.getByText("Stage: build")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for you")).not.toBeInTheDocument();
  });

  it.each(["spec_review", "plan_review", "pr_open", "blocked"] as const)("marks_%s_as_waiting_for_you", (status) => {
    render(<TaskCard task={task({ status })} onNavigate={vi.fn()} />);
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
  });

  it("shows_the_first_line_of_a_blocked_question", () => {
    render(<TaskCard task={task({ question: "Which base branch?\nThe repo has dev and stg.", status: "blocked" })} onNavigate={vi.fn()} />);
    expect(screen.getByText("Which base branch?")).toBeInTheDocument();
    expect(screen.queryByText(/The repo has dev and stg/)).not.toBeInTheDocument();
  });

  it("opens_the_task_in_the_app", () => {
    const onNavigate = vi.fn();
    render(<TaskCard task={task()} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "Add a filter" }));
    expect(onNavigate).toHaveBeenCalledWith("/tasks/T-7");
  });
});
