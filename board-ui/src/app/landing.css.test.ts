import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { phoneRules } from "../test/cssMedia";
import { tokens } from "../test/cssTokens";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), "utf8");
const css = read("board.css");

/** Body of the first top-level at-rule whose prelude is exactly `prelude`, by brace counting. */
function atBlock(source: string, prelude: string): string {
  const start = source.indexOf(`${prelude} {`);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return "";
}

/** Declarations of the phone rule whose selector is exactly `selector` (later rules win). */
function phone(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of phoneRules(css)) if (rule.selector === selector) Object.assign(out, rule.decls);
  return out;
}

describe("landing styles", () => {
  it("title_is_the_display_style", () => {
    const t = tokens(css, ".sf-landing-title");
    expect(t["font-family"]).toBe("var(--sf-font)");
    expect(t["font-size"]).toBe("clamp(48px, 10vw, 128px)");
    expect(t["font-weight"]).toBe("700");
    expect(t["line-height"]).toBe("1");
    expect(t["letter-spacing"]).toBe("-0.025em");
    expect(t.color).toBe("var(--sf-text)");
  });

  it("lead_is_16_24_muted", () => {
    const t = tokens(css, ".sf-landing-lead");
    expect(t["font-size"]).toBe("16px");
    expect(t["line-height"]).toBe("24px");
    expect(t.color).toBe("var(--sf-muted)");
  });

  it("hero_is_a_12_column_grid_in_a_chrome_border_frame", () => {
    const t = tokens(css, ".sf-landing-hero");
    expect(t.display).toBe("grid");
    expect(t["grid-template-columns"]).toBe("repeat(12, minmax(0, 1fr))");
    expect(t.border).toBe("1px solid var(--sf-chrome-border)");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
    expect(tokens(css, ".sf-landing-hero > *")["grid-column"]).toBe("1 / span 9");
  });

  it("steps_are_six_then_two_then_one_columns", () => {
    expect(tokens(css, ".sf-landing-steps")["grid-template-columns"]).toBe("repeat(6, minmax(0, 1fr))");
    expect(tokens(atBlock(css, "@media (max-width: 1099px)"), ".sf-landing-steps")["grid-template-columns"]).toBe("repeat(2, minmax(0, 1fr))");
    expect(phone(".sf-landing-steps")["grid-template-columns"]).toBe("1fr");
    expect(tokens(css, ".sf-landing-cards")["grid-template-columns"]).toBe("repeat(3, minmax(0, 1fr))");
    expect(phone(".sf-landing-cards")["grid-template-columns"]).toBe("1fr");
  });

  it("base_landing_rules_come_before_the_1099_block", () => {
    const base = css.indexOf(".sf-landing-steps {");
    expect(base).toBeGreaterThan(-1);
    expect(base).toBeLessThan(css.indexOf("@media (max-width: 1099px)"));
  });

  it("cells_are_outlined_3px", () => {
    const t = tokens(css, ".sf-landing-cell");
    expect(t.border).toBe("1px solid var(--sf-border)");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
    expect(t.background).toBe("transparent");
  });

  it("kicker_and_footer_are_label_type_muted", () => {
    expect(tokens(css, ".sf-landing-kicker").color).toBe("var(--sf-muted)");
    expect(tokens(css, ".sf-landing-footer").color).toBe("var(--sf-muted)");
  });

  it("field_is_fixed_full_viewport_behind_content", () => {
    const f = tokens(css, ".sf-landing-field");
    expect(f.position).toBe("fixed");
    expect(f.inset).toBe("0");
    expect(f.width).toBe("100%");
    expect(f.height).toBe("100%");
    expect(f["pointer-events"]).toBe("none");
    expect(f["z-index"]).toBe("0");
    const rest = tokens(css, ".sf-landing > :not(.sf-landing-field)");
    expect(rest.position).toBe("relative");
    expect(rest["z-index"]).toBe("1");
  });

  it("landing_section_has_no_shadow_raw_colour_or_other_radius", () => {
    const start = css.indexOf("/* Landing */");
    const end = css.indexOf("/* Below the 1024px");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(slice).not.toMatch(/box-shadow/);
    expect(slice).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(slice).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    for (const m of slice.matchAll(/border-radius\s*:\s*([^;}]+)/g)) expect((m[1] ?? "").trim()).toBe("var(--sf-radius)");
    for (const m of slice.matchAll(/transition\s*:\s*([^;}]+)/g)) expect(m[1]).toMatch(/150ms/);
    expect(slice).not.toMatch(/\.grid(?![\w-])/);
    expect(slice).not.toMatch(/\.outline(?![\w-])/);
  });

});

describe("the old sign-in card is gone", () => {
  it("styles_css_has_no_auth_or_brand_mark_rules", () => {
    expect(read("styles.css")).not.toMatch(/\.(auth-screen|auth-card|auth-brand|auth-submit|brand-mark)\b/);
  });

  it("no_source_uses_auth_classes", () => {
    const srcRoot = join(here, "..");
    const files = (readdirSync(srcRoot, { recursive: true }) as string[]).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const bad = files.filter((f) => /className="[^"]*\bauth-/.test(readFileSync(join(srcRoot, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
