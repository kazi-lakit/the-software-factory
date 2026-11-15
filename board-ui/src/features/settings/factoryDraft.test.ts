import { DEFAULT_LABEL, validateFactoryDef, type GitHubSettings } from "@factory/core";
import { describe, expect, it } from "vitest";
import { defFixture } from "../../test/factories";
import { addProtectedBranch, draftOf, githubDraftOf, toFactoryInput } from "./factoryDraft";

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

  const stored: GitHubSettings = {
    mode: "connected", project: { owner: "acme", number: 7 }, label: "ops", approvers: ["ann", "bob"],
    statusMap: { ...githubDraftOf(undefined).statusMap, done: "Shipped" }
  };

  it("saving_an_unrelated_field_keeps_the_github_block", () => {
    const base = { ...defFixture("delta"), github: stored };
    const input = toFactoryInput({ ...draftOf(base), name: "Renamed" }, base);
    const checked = validateFactoryDef(input);
    expect(checked.ok && checked.value.github).toEqual(stored);
  });

  it("a_stored_github_only_block_survives_toFactoryInput_unchanged", () => {
    const only: GitHubSettings = { ...stored, mode: "github-only" };
    const base = { ...defFixture("delta"), github: only };
    const checked = validateFactoryDef(toFactoryInput(draftOf(base), base));
    expect(checked.ok && checked.value.github).toEqual(only);
  });

  it("off_drops_github_and_connected_with_blank_approvers_leaves_them_to_the_default", () => {
    const base = { ...defFixture("delta"), github: stored };
    expect(toFactoryInput({ ...draftOf(base), github: { ...draftOf(base).github, mode: "off" } }, base).github).toBeUndefined();
    const blank = toFactoryInput({ ...draftOf(base), github: { ...draftOf(base).github, approvers: " , " } }, base).github;
    expect(blank).not.toHaveProperty("approvers");
    const checked = validateFactoryDef({ ...toFactoryInput(draftOf(base), base), github: blank });
    expect(checked.ok && checked.value.github?.approvers).toEqual(["gh-delta"]);
    expect(githubDraftOf(undefined)).toMatchObject({ mode: "off", project: "", label: DEFAULT_LABEL, approvers: "" });
  });
});
