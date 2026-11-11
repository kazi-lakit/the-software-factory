import { describe, expect, it } from "vitest";
import { defFixture } from "../../test/factories";
import { addProtectedBranch, draftOf, toFactoryInput } from "./factoryDraft";

describe("factoryDraft", () => {
  it("builds_an_add_def_with_version_1_and_no_agentModels_when_all_same_as_session", () => {
    const input = toFactoryInput({ ...draftOf(null), factoryId: "echo", name: "Echo" }, null);
    expect(input).toMatchObject({ factoryId: "echo", name: "Echo", version: 1, protectedBranches: ["dev", "stg", "main"] });
    expect(input.agentModels).toEqual({});
    expect("models" in input).toBe(false);
  });

  it("keeps_the_base_version_on_edit", () => {
    const base = { ...defFixture("delta"), version: 4 };
    const draft = { ...draftOf(base), models: { ...draftOf(base).models, build: "sonnet" as const } };
    expect(toFactoryInput(draft, base)).toMatchObject({ factoryId: "delta", version: 4, agentModels: { build: "sonnet" } });
  });

  it("adds_a_branch_before_main_and_ignores_blank", () => {
    expect(addProtectedBranch(["dev", "main"], " rel ")).toEqual(["dev", "rel", "main"]);
    expect(addProtectedBranch(["dev", "main"], "   ")).toEqual(["dev", "main"]);
    expect(addProtectedBranch(["dev", "main"], "dev")).toEqual(["dev", "main"]);
  });
});
