import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// styles.css keeps only the bare resets (T-23). Every class rule lives in board.css,
// including the landing page (T-22), which replaced the last user of Alert.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const css = readFileSync(join(here, "styles.css"), "utf8");
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

function sourceFiles(pattern: RegExp): string[] {
  return (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((f) => pattern.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(srcRoot, f));
}

function classNames(): Set<string> {
  const names = new Set<string>();
  for (const m of clean.matchAll(/([^{}]+)\{/g)) {
    const prelude = (m[1] ?? "").trim();
    if (prelude.startsWith("@")) continue;
    for (const c of prelude.matchAll(/\.([a-zA-Z][\w-]*)/g)) names.add(c[1] ?? "");
  }
  return names;
}

describe("styles_css_cleanup", () => {
  it("styles_css_has_no_scaffold_tokens_font_or_raw_colours", () => {
    for (const banned of ["--primary", "hsl(var(", ":root:not(", "#c0c9d1", "rgba(15, 23, 42", "@keyframes blocks-"]) {
      expect(css, banned).not.toContain(banned);
    }
    expect(css).not.toMatch(/\bInter\b/);
    expect(clean).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).toContain("@tailwind base;");
  });

  it("every_class_rule_in_styles_css_is_used_by_a_tsx_file", () => {
    const sources = sourceFiles(/\.tsx$/).map((f) => readFileSync(f, "utf8"));
    const unused = [...classNames()]
      .filter((name) => !sources.some((s) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(s)));
    expect(unused).toEqual([]);
  });

  it("no_class_rules_remain_and_the_unused_alert_is_gone", () => {
    expect([...classNames()]).toEqual([]);
    expect(existsSync(join(srcRoot, "shared/ui/Alert.tsx"))).toBe(false);
  });

  it("board_ui_has_no_inter_primary_token_or_hsl_var", () => {
    const files = [...sourceFiles(/\.(tsx?|css)$/), join(srcRoot, "../index.html"), join(srcRoot, "../tailwind.config.ts")];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\bInter\b/);
      expect(text, file).not.toMatch(/--primary:/);
      expect(text, file).not.toContain("hsl(var(");
    }
  });
});
