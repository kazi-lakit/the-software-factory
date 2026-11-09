import { describe, expect, it } from "vitest";
import { isFactoryOwner } from "./roles";

describe("isFactoryOwner", () => {
  it("accepts_an_iam_me_answer_whose_roles_include_factory_owner", () => {
    expect(isFactoryOwner({ data: { roles: ["viewer", "factory-owner"] } })).toBe(true);
  });

  it.each([
    ["no answer", undefined],
    ["null", null],
    ["a string", "factory-owner"],
    ["an array", [{ roles: ["factory-owner"] }]],
    ["no data", {}],
    ["data null", { data: null }],
    ["data an array", { data: ["factory-owner"] }],
    ["roles missing", { data: {} }],
    ["roles empty", { data: { roles: [] } }],
    ["roles a string", { data: { roles: "factory-owner" } }],
    ["roles an object", { data: { roles: { "factory-owner": true } } }],
    ["a non-string role", { data: { roles: ["factory-owner", 1] } }],
    ["another role", { data: { roles: ["factory-owners", "owner"] } }],
    ["roles at the top", { roles: ["factory-owner"] }]
  ])("fails_closed_for_%s", (_name, me) => {
    expect(isFactoryOwner(me)).toBe(false);
  });
});
