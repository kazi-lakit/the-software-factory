import { describe, expect, it } from "vitest";
import type { Status, Task } from "@factory/core";
import { byAge, laneOf, LANES, type LaneId } from "./lanes";
import { COLUMNS, NEEDS_YOU } from "./status";

const EXPECTED: Record<string, LaneId> = {
  inbox: "queued", ready: "queued",
  spec: "working", plan: "working", build: "working", verify: "working", review: "working",
  spec_review: "needs-you", plan_review: "needs-you", pr_open: "needs-you", blocked: "needs-you",
  done: "done", cancelled: "stopped"
};

describe("lanes", () => {
  it("lanes_are_in_order_needs_you_queued_working_done_stopped", () => {
    expect(LANES.map((l) => l.name)).toEqual(["Needs you", "Queued", "Working", "Done", "Stopped"]);
    expect(LANES.map((l) => l.id)).toEqual(["needs-you", "queued", "working", "done", "stopped"]);
  });
  it.each(Object.entries(EXPECTED))("maps_%s_to_%s", (status, lane) => {
    expect(laneOf(status as Status)).toBe(lane);
  });
  it("lane_statuses_cover_columns_exactly_once", () => {
    const all = LANES.flatMap((l) => [...l.statuses]);
    expect([...all].sort()).toEqual([...COLUMNS].sort());
    expect(new Set(all).size).toBe(all.length);
  });
  it("needs_you_lane_statuses_equal_NEEDS_YOU", () => {
    expect(new Set(LANES[0]?.statuses)).toEqual(new Set(NEEDS_YOU));
  });
  it("an_unknown_status_falls_back_to_working", () => {
    expect(laneOf("weird" as Status)).toBe("working");
  });
  it("lane_hints_match_the_design", () => {
    const hint = (id: LaneId) => LANES.find((l) => l.id === id)?.hint;
    expect(hint("needs-you")).toBe("Oldest first. Tap a task to act on it.");
    expect(hint("queued")).toBe("Inbox needs Mark ready; ready tasks start when a slot frees.");
    expect(hint("working")).toBeUndefined();
    expect(hint("done")).toBe("Finished and merged");
    expect(hint("stopped")).toBe("Cancelled tasks. Kept for history.");
  });
  it("byAge_sorts_oldest_first_by_number_then_id", () => {
    const tasks = ["T-10", "T-2", "T-9"].map((taskId) => ({ taskId }) as Task);
    expect([...tasks].sort(byAge).map((t) => t.taskId)).toEqual(["T-2", "T-9", "T-10"]);
  });
});
