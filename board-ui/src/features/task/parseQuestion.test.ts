import { describe, expect, it } from "vitest";
import { optionText, parseQuestion, recommendedLetter } from "./parseQuestion";

const EXAMPLE = "Which branch?\nA. main: fits the others (recommended)\nB. develop: more work\nReply with an option letter, or answer in your own words.";

describe("parseQuestion", () => {
  it("parses_prompt_and_two_options_dropping_the_reply_line", () => {
    const parsed = parseQuestion(EXAMPLE);
    expect(parsed.prompt).toBe("Which branch?");
    expect(parsed.options).toEqual([
      { letter: "A", label: "main", recommended: true, why: "fits the others" },
      { letter: "B", label: "develop", recommended: false, why: "more work" }
    ]);
  });

  it("marks_a_trailing_recommended_and_strips_it", () => {
    const [a] = parseQuestion(EXAMPLE).options;
    expect(a?.recommended).toBe(true);
    expect(a?.why).not.toContain("recommended");
  });

  it("option_without_a_why_has_an_empty_why", () => {
    const { options } = parseQuestion("Pick?\nA. Yes\nB. No: because");
    expect(options[0]).toMatchObject({ label: "Yes", why: "" });
    expect(options[1]).toMatchObject({ label: "No", why: "because" });
  });

  it("plain_text_has_no_options", () => {
    expect(parseQuestion("Should I continue?")).toEqual({ prompt: "Should I continue?", options: [] });
  });

  it("a_single_option_line_falls_back", () => {
    const text = "Q?\nA. only: one";
    expect(parseQuestion(text)).toEqual({ prompt: text, options: [] });
  });

  it("more_than_four_options_falls_back", () => {
    const text = "Q?\nA. a: x\nB. b: x\nC. c: x\nD. d: x\nE. e: x";
    expect(parseQuestion(text).options).toEqual([]);
  });

  it("non_consecutive_or_malformed_option_lines_fall_back_without_throwing", () => {
    expect(parseQuestion("Q?\nA. a: x\nsome text\nB. b: y").options).toEqual([]);
    expect(parseQuestion("Q?\nA. a: x\nB.\n").options).toEqual([]);
    expect(parseQuestion("").options).toEqual([]);
  });

  it("exactly_one_recommended_is_reported_via_recommendedLetter", () => {
    expect(recommendedLetter(parseQuestion(EXAMPLE).options)).toBe("A");
    expect(recommendedLetter(parseQuestion("Q?\nA. a: x\nB. b: y").options)).toBeUndefined();
    expect(recommendedLetter(parseQuestion("Q?\nA. a: x (recommended)\nB. b: y (recommended)").options)).toBeUndefined();
  });

  it("tolerates_a_blank_line_before_the_reply_line", () => {
    const parsed = parseQuestion("Which?\nA. main: fits (recommended)\nB. develop: more\n\nReply with an option letter.");
    expect(parsed.options.map((o) => o.letter)).toEqual(["A", "B"]);
  });

  it("optionText_returns_the_line_without_the_recommended_suffix", () => {
    const [a, b] = parseQuestion(EXAMPLE + "\n").options;
    expect(optionText(a!)).toBe("A. main: fits the others");
    expect(optionText(b!)).toBe("B. develop: more work");
    expect(optionText({ letter: "C", label: "x", why: "", recommended: false })).toBe("C. x");
  });
});
