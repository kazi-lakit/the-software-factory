import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Status, Task } from "@factory/core";
import { Stepper } from "./Stepper";

const states = (container: HTMLElement) =>
  [...container.querySelectorAll(".sf-step")].map((el) => el.getAttribute("data-state"));
const renderStepper = (status: Status, stage: Task["stage"] = null, waitingVersion?: number, baseBranch = "dev") =>
  render(<Stepper status={status} stage={stage} baseBranch={baseBranch} waitingVersion={waitingVersion} />);
const labels = (container: HTMLElement) =>
  [...container.querySelectorAll(".sf-step")].map((el) => el.firstChild?.textContent);

afterEach(cleanup);

describe("Stepper", () => {
  it("stepper_renders_six_labelled_steps_in_order", () => {
    renderStepper("plan_review", "plan");
    const items = screen.getAllByRole("listitem", { hidden: true });
    expect(items).toHaveLength(6);
    for (const li of items) expect(li.querySelectorAll(".sf-step")).toHaveLength(1);
    expect(items.map((li) => li.querySelector(".sf-step")?.firstChild?.textContent)).toEqual(["Spec", "Plan · waiting", "Build", "Verify", "Review", "PR into dev"]);
    for (const li of items) expect(li.querySelector(".sf-step")).toHaveClass("sf-stepper-label", "sf-label");
  });

  it("stepper_has_no_separate_bar", () => {
    const { container } = renderStepper("plan_review", "plan");
    const steps = [...container.querySelectorAll(".sf-step")];
    expect(steps).toHaveLength(6);
    for (const step of steps) expect(step.textContent?.trim()).not.toBe("");
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

  it("spec_review_spec_step_reads_its_version_waiting", () => {
    const { container } = renderStepper("spec_review", "spec", 2);
    expect(labels(container)[0]).toBe("Spec · v2 waiting");
    expect(within(container.querySelector(".sf-stepper-item-waiting") as HTMLElement).getByText("(waiting for you)")).toHaveClass("sf-visually-hidden");
  });

  it("plan_review_plan_step_reads_its_version_waiting", () => {
    const { container } = renderStepper("plan_review", "plan", 1);
    expect(labels(container)[1]).toBe("Plan · v1 waiting");
  });

  it("waiting_doc_step_without_a_version_reads_waiting", () => {
    const { container } = renderStepper("spec_review", "spec");
    expect(labels(container)[0]).toBe("Spec · waiting");
  });

  it("blocked_step_reads_question", () => {
    const first = renderStepper("blocked", "spec");
    expect(labels(first.container)[0]).toBe("Spec · question");
    first.unmount();
    const { container } = renderStepper("blocked", "build");
    expect(labels(container)).toEqual(["Spec", "Plan", "Build · question", "Verify", "Review", "PR into dev"]);
  });

  it("last_step_always_reads_pr_into_base", () => {
    for (const [status, stage, base, expected] of [
      ["build", "build", "main", "PR into main"],
      ["pr_open", "ship", "dev", "PR into dev"],
      ["done", null, "dev", "PR into dev"]
    ] as const) {
      const { container, unmount } = renderStepper(status, stage, undefined, base);
      expect(labels(container).at(-1)).toBe(expected);
      unmount();
    }
  });

  it("other_steps_keep_plain_names_and_progress_label", () => {
    const { container } = renderStepper("build", "build");
    expect(labels(container)).toEqual(["Spec", "Plan", "Build", "Verify", "Review", "PR into dev"]);
    expect(screen.getByRole("img", { name: "Progress: Build, step 3 of 6" })).toBeInTheDocument();
  });
});

describe("Stepper short labels", () => {
  const shortNames = (container: HTMLElement) =>
    [...container.querySelectorAll(".sf-stepper-name")].map((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelector(".sf-stepper-more")?.remove();
      return copy.textContent;
    });

  it("stepper_short_names_with_more_in_a_span", () => {
    const { container } = renderStepper("plan_review", "plan", 1, "dev");
    expect(shortNames(container)).toEqual(["Spec", "Plan", "Build", "Verify", "Review", "PR"]);
    expect([...container.querySelectorAll(".sf-stepper-more")].map((el) => el.textContent)).toEqual([" · v1 waiting", " into dev"]);
    expect(container.querySelectorAll(".sf-stepper-name")[1]?.querySelector(".sf-stepper-more")).not.toBeNull();
  });

  it("blocked_more_reads_question", () => {
    const { container } = renderStepper("blocked", "build");
    const build = container.querySelectorAll(".sf-stepper-name")[2];
    expect(build?.querySelector(".sf-stepper-more")?.textContent).toBe(" · question");
  });
});
