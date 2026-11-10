import { describe, expect, it } from "vitest";
import type { Status, Task } from "@factory/core";
import { ageOf, ctaLabel, progressLabel, progressSteps, STEPS, type StepState } from "./status";

type Stage = Task["stage"];
const T = "todo", D = "done", C = "current", W = "waiting";

describe("status helpers", () => {
  it("step_labels_are_spec_plan_build_verify_review_pr", () => {
    expect([...STEPS]).toEqual(["Spec", "Plan", "Build", "Verify", "Review", "PR"]);
  });

  it("ctaLabel_maps_each_waiting_status", () => {
    expect(ctaLabel("spec_review", null)).toBe("Review the spec");
    expect(ctaLabel("plan_review", null)).toBe("Review the plan");
    expect(ctaLabel("pr_open", null)).toBe("Review the PR");
    expect(ctaLabel("blocked", "Q?")).toBe("Answer the question");
    expect(ctaLabel("blocked", null)).toBe("See why it stopped");
    expect(ctaLabel("blocked", "  \n ")).toBe("See why it stopped");
    for (const s of ["inbox", "ready", "spec", "plan", "build", "verify", "review", "done", "cancelled"] as Status[]) {
      expect(ctaLabel(s, "Q?")).toBeNull();
    }
  });

  it.each<[Status, Stage, StepState[]]>([
    ["inbox", null, [T, T, T, T, T, T]],
    ["ready", null, [T, T, T, T, T, T]],
    ["spec", "spec", [C, T, T, T, T, T]],
    ["plan", "plan", [D, C, T, T, T, T]],
    ["build", "build", [D, D, C, T, T, T]],
    ["verify", "verify", [D, D, D, C, T, T]],
    ["review", "review", [D, D, D, D, C, T]],
    ["spec_review", null, [W, T, T, T, T, T]],
    ["plan_review", null, [D, W, T, T, T, T]],
    ["pr_open", null, [D, D, D, D, D, W]],
    ["done", null, [D, D, D, D, D, D]],
    ["cancelled", "build", [D, D, T, T, T, T]],
    ["cancelled", null, [T, T, T, T, T, T]],
    ["blocked", "plan", [D, W, T, T, T, T]],
    ["blocked", "check", [D, D, W, T, T, T]],
    ["blocked", "ship", [D, D, D, D, D, W]],
    ["blocked", null, [T, T, T, T, T, T]]
  ])("progressSteps_maps_every_status_%s_%s", (status, stage, expected) => {
    expect(progressSteps(status, stage)).toEqual(expected);
  });

  it("progressLabel_names_the_current_step", () => {
    expect(progressLabel("build", "build")).toBe("Progress: Build, step 3 of 6");
    expect(progressLabel("spec_review", null)).toBe("Progress: Spec, step 1 of 6");
    expect(progressLabel("inbox", null)).toBe("Progress: not started");
    expect(progressLabel("cancelled", "build")).toBe("Progress: stopped");
    expect(progressLabel("done", null)).toBe("Progress: done");
    expect(progressLabel("blocked", null)).toBe("Progress: stopped");
  });
});

describe("ageOf", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("ageOf_just_now_under_a_minute", () => {
    expect(ageOf(ago(30_000), now)).toBe("just now");
  });
  it("ageOf_formats_minutes_hours_days", () => {
    expect(ageOf(ago(5 * 60_000), now)).toBe("5m");
    expect(ageOf(ago(5 * 3_600_000), now)).toBe("5h");
    expect(ageOf(ago(3 * 86_400_000), now)).toBe("3d");
  });
  it("ageOf_returns_null_for_undefined_or_invalid", () => {
    expect(ageOf(undefined, now)).toBeNull();
    expect(ageOf("garbage", now)).toBeNull();
  });
});
