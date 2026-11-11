import { describe, expect, it } from "vitest";
import { idFromName } from "./factoryId";

describe("idFromName", () => {
  it("lowercases_and_hyphenates_runs", () => {
    expect(idFromName("My Factory 2")).toBe("my-factory-2");
    expect(idFromName("Acme  &  Co")).toBe("acme-co");
  });

  it("drops_leading_non_letters_and_trims_hyphens", () => {
    expect(idFromName("2 Fast!")).toBe("fast");
    expect(idFromName("--Echo--")).toBe("echo");
    expect(idFromName("123")).toBe("");
  });

  it("caps_at_40_characters_without_a_trailing_hyphen", () => {
    const id = idFromName(`${"a".repeat(39)} ${"b".repeat(20)}`);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith("-")).toBe(false);
    expect(id).toBe("a".repeat(39));
  });
});
