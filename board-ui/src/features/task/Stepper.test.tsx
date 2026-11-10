import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Status, Task } from "@factory/core";
import { Stepper } from "./Stepper";

const states = (container: HTMLElement) =>
  [...container.querySelectorAll(".sf-step")].map((el) => el.getAttribute("data-state"));
const renderStepper = (status: Status, stage: Task["stage"] = null) => render(<Stepper status={status} stage={stage} />);

afterEach(cleanup);

describe("Stepper", () => {
  it("stepper_renders_six_labelled_steps_in_order", () => {
    renderStepper("plan_review", "plan");
    const items = screen.getAllByRole("listitem", { hidden: true });
    expect(items).toHaveLength(6);
    expect(items.map((li) => li.querySelector(".sf-stepper-label")?.firstChild?.textContent)).toEqual(["Spec", "Plan", "Build", "Verify", "Review", "PR"]);
  });

  it("stepper_has_role_img_and_progress_label", () => {
    renderStepper("plan_review", "plan");
    expect(screen.getByRole("img", { name: "Progress: Plan, step 2 of 6" })).toBeInTheDocument();
  });

  it("stepper_finished_steps_are_done", () => {
    const { container } = renderStepper("build", "build");
    expect(states(container)).toEqual(["done", "done", "current", "todo", "todo", "todo"]);
  });

  it("stepper_waiting_step_is_marked", () => {
    const { container } = renderStepper("plan_review", "plan");
    expect(states(container)).toEqual(["done", "waiting", "todo", "todo", "todo", "todo"]);
    const item = container.querySelector(".sf-stepper-item-waiting") as HTMLElement;
    expect(item).toHaveTextContent("Plan");
    expect(item.querySelector(".sf-stepper-label")).toHaveClass("sf-stepper-label-waiting");
    expect(within(item).getByText("(waiting for you)")).toHaveClass("sf-visually-hidden");
  });

  it("stepper_todo_steps_have_no_done_or_waiting_state", () => {
    const { container } = renderStepper("spec_review", "spec");
    const todo = [...container.querySelectorAll(".sf-stepper-item")].filter((li) => li.getAttribute("data-state") === "todo");
    expect(todo).toHaveLength(5);
    for (const li of todo) expect(li.className).not.toMatch(/waiting|done/);
  });

  it("stepper_done_task_has_six_done_and_no_waiting", () => {
    const { container } = renderStepper("done");
    expect(states(container)).toEqual(Array(6).fill("done"));
    expect(container.querySelector(".sf-stepper-item-waiting")).toBeNull();
  });

  it("stepper_cancelled_has_no_waiting", () => {
    const { container } = renderStepper("cancelled", "build");
    expect(states(container)).not.toContain("waiting");
  });

  it("stepper_shows_no_waiting_when_not_waiting", () => {
    const { container } = renderStepper("build", "build");
    expect(container.querySelector(".sf-stepper-item-waiting")).toBeNull();
    expect(states(container)).not.toContain("waiting");
  });

  it("blocked_waits_at_its_stage_step", () => {
    const { container } = renderStepper("blocked", "build");
    expect(states(container)).toEqual(["done", "done", "waiting", "todo", "todo", "todo"]);
  });
});
