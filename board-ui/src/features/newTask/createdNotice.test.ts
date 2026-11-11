import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@factory/core";
import { describeWriteError } from "../task/writeOutcome";
import { clearReadyProblem, peekReadyProblem, setReadyProblem } from "./createdNotice";

describe("createdNotice", () => {
  it("peek_returns_the_problem_for_its_task_until_cleared", () => {
    const problem = describeWriteError(new ForbiddenError("no"));
    setReadyProblem("T-1", problem);
    expect(peekReadyProblem("T-2")).toBeUndefined();
    expect(peekReadyProblem("T-1")).toBe(problem);
    expect(peekReadyProblem("T-1")).toBe(problem);
    clearReadyProblem("T-1");
    expect(peekReadyProblem("T-1")).toBeUndefined();
  });
});
