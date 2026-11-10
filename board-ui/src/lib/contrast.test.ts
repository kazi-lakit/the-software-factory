import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
  ["on-accent", "accent"], ["on-primary", "primary"], ["on-primary-soft", "primary-soft"],
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
    ["focus", "progress", "accent"].flatMap((fg) => ["bg", "surface"].map((bg) => [t, fg, bg] as const))
  );
  it.each(cases)("%s: %s on %s", (theme, fg, bg) => {
    const t = themes[theme] as Record<string, string>;
    const back = parse(t[`--sf-${bg}`] as string).rgb;
    const r = ratio(over(parse(t[`--sf-${fg}`] as string), back), back);
    expect(r, `${theme}: ${fg} on ${bg} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });
});
