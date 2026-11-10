import { describe, expect, it } from "vitest";
import type { Status } from "@factory/core";
import { laneOf, LANES, type LaneId } from "./lanes";
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
  it("every_lane_has_a_one_line_hint", () => {
    expect(LANES[0]?.hint).toBe("Waiting for your review or answer");
    for (const l of LANES) {
      expect(l.hint.length).toBeGreaterThan(0);
      expect(l.hint).not.toMatch(/\n/);
    }
  });
});
