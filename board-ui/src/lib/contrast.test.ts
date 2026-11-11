import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOT_ALPHA_MAX, DOT_RGB } from "../features/landing/dotField";
import { tokens } from "../test/cssTokens";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app/board.css"), "utf8");
const dark = tokens(css, ":root");
const themes: Record<string, Record<string, string>> = {
  dark,
  light: { ...dark, ...tokens(css, ':root[data-theme="light"]') }
};

type Rgb = [number, number, number];
function parse(value: string): { rgb: Rgb; alpha: number } {
  const v = value.trim();
  const rgba = v.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  let h = v.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`cannot parse colour "${value}"`);
  return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
}

export function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const over = (fg: { rgb: Rgb; alpha: number }, bg: Rgb): Rgb =>
  fg.rgb.map((c, i) => c * fg.alpha + (bg[i] as number) * (1 - fg.alpha)) as Rgb;

const textPairs: [string, string][] = [
  ["text", "bg"], ["text", "surface"], ["text", "surface-sunk"],
  ["muted", "bg"], ["muted", "surface"], ["muted", "surface-sunk"],
  ["done", "bg"], ["done", "surface"], ["done", "surface-sunk"], ["done", "done-soft"],
  ["accent-text", "accent-soft"], ["accent-text", "bg"], ["accent-text", "surface"],
  ["on-accent", "accent"], ["on-primary", "primary"], ["on-primary", "primary-hover"], ["on-primary-soft", "primary-soft"],
  ["added", "added-soft"], ["removed", "removed-soft"]
];

describe("ratio_helper_matches_known_values", () => {
  it("matches_black_on_white_and_777_on_white", () => {
    expect(ratio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(ratio([0x77, 0x77, 0x77], [255, 255, 255])).toBeCloseTo(4.48, 2);
  });
});

describe("text_pairs_meet_4_5_to_1", () => {
  const cases = Object.keys(themes).flatMap((t) => textPairs.map(([fg, bg]) => [t, fg, bg] as const));
  it.each(cases)("%s: %s on %s", (theme, fg, bg) => {
    const t = themes[theme] as Record<string, string>;
    const r = ratio(parse(t[`--sf-${fg}`] as string).rgb, parse(t[`--sf-${bg}`] as string).rgb);
    expect(r, `${theme}: ${fg} on ${bg} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

// `border` is owner-specified (rgba .45 dark, .3 light) and measures about 2.6:1 dark and 2.0:1 light on bg and surface,
// under 3:1. It is a hairline around text-bearing boxes, not the only cue, so it is reported in the build notes rather
// than changed or tested here. chrome-border and needs-tint are decorative.
describe("non_text_colours_meet_3_to_1", () => {
  const cases = Object.keys(themes).flatMap((t) =>
    ["focus", "progress", "accent"].flatMap((fg) => ["bg", "surface", "accent-soft"].map((bg) => [t, fg, bg] as const))
  );
  it.each(cases)("%s: %s on %s", (theme, fg, bg) => {
    const t = themes[theme] as Record<string, string>;
    const back = parse(t[`--sf-${bg}`] as string).rgb;
    const r = ratio(over(parse(t[`--sf-${fg}`] as string), back), back);
    expect(r, `${theme}: ${fg} on ${bg} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });
});

// The task page's new text pairs: stepper labels (muted, waiting in accent-text) on the page, details terms on the surface panel.
describe("task_page_text_pairs_meet_4_5_to_1", () => {
  const rules: [string, string, string][] = [
    [".sf-stepper-label", "muted", "bg"],
    [".sf-stepper-item-waiting .sf-stepper-label", "accent-text", "bg"],
    [".sf-details dt", "muted", "surface"],
    [".sf-task-meta", "muted", "bg"]
  ];
  const cases = Object.keys(themes).flatMap((t) => rules.map(([sel, fg, bg]) => [t, sel, fg, bg] as const));
  it.each(cases)("%s: %s (%s on %s)", (theme, selector, fg, bg) => {
    const declared = tokens(css, selector).color;
    expect(declared, `${selector} sets no colour`).toBe(`var(--sf-${fg})`);
    const t = themes[theme] as Record<string, string>;
    const r = ratio(parse(t[`--sf-${fg}`] as string).rgb, parse(t[`--sf-${bg}`] as string).rgb);
    expect(r, `${theme}: ${selector} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

// Task-page step chips: each state's text on its own fill (or on the page when transparent).
describe("step_chip_text_pairs_meet_4_5_to_1", () => {
  const rules: [string, string, string][] = [
    ['.sf-stepper .sf-step[data-state="done"]', "done", "done-soft"],
    ['.sf-stepper .sf-step[data-state="current"]', "text", "bg"],
    ['.sf-stepper .sf-step[data-state="waiting"]', "accent-text", "accent-soft"],
    ['.sf-stepper .sf-step[data-state="todo"]', "muted", "bg"]
  ];
  const cases = Object.keys(themes).flatMap((t) => rules.map(([sel, fg, bg]) => [t, sel, fg, bg] as const));
  it.each(cases)("%s: %s (%s on %s)", (theme, selector, fg, bg) => {
    expect(tokens(css, selector).color, `${selector} sets no colour`).toBe(`var(--sf-${fg})`);
    const t = themes[theme] as Record<string, string>;
    const r = ratio(parse(t[`--sf-${fg}`] as string).rgb, parse(t[`--sf-${bg}`] as string).rgb);
    expect(r, `${theme}: ${selector} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

// The danger outline (Cancel task) on the page, a panel and its own hover fill.
describe("danger_button_meets_4_5_to_1", () => {
  it("uses_the_removed_colour", () => {
    expect(tokens(css, ".sf-button-danger").color).toBe("var(--sf-removed)");
  });
  const cases = Object.keys(themes).flatMap((t) => ["bg", "surface", "primary-soft"].map((bg) => [t, bg] as const));
  it.each(cases)("%s: removed on %s", (theme, bg) => {
    const t = themes[theme] as Record<string, string>;
    const r = ratio(parse(t["--sf-removed"] as string).rgb, parse(t[`--sf-${bg}`] as string).rgb);
    expect(r, `${theme}: removed on ${bg} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

// The landing page: its text sits on the page field, under the static 16px grid dot and a WebGL dot at its brightest.
describe("landing_text_meets_4_5_over_the_field", () => {
  const gridDot: Record<string, { rgb: Rgb; alpha: number }> = {
    dark: { rgb: [157, 176, 175], alpha: 0.045 },
    light: { rgb: [11, 17, 18], alpha: 0.035 }
  };
  const cases = (["dark", "light"] as const).flatMap((theme) => ["text", "muted", "accent-text"].map((fg) => [theme, fg] as const));
  it.each(cases)("%s: %s over the field", (theme, fg) => {
    const t = themes[theme] as Record<string, string>;
    const bg = parse(t["--sf-bg"] as string).rgb;
    const field = over({ rgb: DOT_RGB[theme], alpha: DOT_ALPHA_MAX[theme] }, over(gridDot[theme] as { rgb: Rgb; alpha: number }, bg));
    const text = parse(t[`--sf-${fg}`] as string).rgb;
    const onField = ratio(text, field);
    expect(onField, `${theme}: ${fg} over the field is ${onField.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    const onBg = ratio(text, bg);
    expect(onBg, `${theme}: ${fg} on bg is ${onBg.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("landing_selectors_use_only_text_tokens", () => {
  const rules: [string, string][] = [
    [".sf-landing-title", "text"],
    [".sf-landing-heading", "text"],
    [".sf-landing-cell-title", "text"],
    [".sf-landing-brand", "text"],
    [".sf-landing-lead", "muted"],
    [".sf-landing-kicker", "muted"],
    [".sf-landing-cell-text", "muted"],
    [".sf-landing-footer", "muted"],
    [".sf-landing-notice", "muted"]
  ];
  it.each(rules)("%s is %s", (selector, fg) => {
    expect(tokens(css, selector).color, `${selector} colour`).toBe(`var(--sf-${fg})`);
  });
});
