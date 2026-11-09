import { describe, expect, it } from "vitest";
import { BlocksForbiddenError, BlocksUnauthorizedError, ForbiddenError, OwnerActionError, StaleDocError, VersionConflictError } from "@factory/core";
import { CONFLICT_MESSAGE, describeWriteError, FORBIDDEN_MESSAGE } from "./writeOutcome";

describe("describeWriteError", () => {
  it("maps_each_outcome_to_the_page_message", () => {
    expect(describeWriteError(new VersionConflictError("T-1", 1, 2))).toEqual({ kind: "conflict", message: CONFLICT_MESSAGE });
    expect(describeWriteError(new StaleDocError("T-1", "plan", 1, 3))).toMatchObject({
      currentVersion: 3, kind: "stale", message: "The plan changed since you opened it (now v3). Review the new version first.", seenVersion: 1
    });
    expect(describeWriteError(new OwnerActionError("not-blocked", "T-1 is not blocked"))).toEqual({ kind: "message", message: "T-1 is not blocked" });
    expect(describeWriteError(new ForbiddenError("no"))).toEqual({ kind: "message", message: FORBIDDEN_MESSAGE });
    expect(describeWriteError(new BlocksForbiddenError("getFactoryTasks"))).toEqual({ kind: "message", message: FORBIDDEN_MESSAGE });
    expect(describeWriteError(new BlocksUnauthorizedError()).message).toMatch(/session ended/);
  });

  it("does_not_trust_an_error_that_only_borrows_a_name", () => {
    const lookalike = Object.assign(new Error("blocks: getFactoryTasks forbidden"), { name: "BlocksForbiddenError" });
    expect(describeWriteError(lookalike).message).toBe("The change was not saved: blocks: getFactoryTasks forbidden");
  });
});
