import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const read = (name: string) => readFileSync(join(here, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("no_shadows", () => {
  it("no_non_none_box_shadow_in_stylesheets", () => {
    for (const f of ["board.css", "styles.css"]) {
      const bad = (read(f).match(/box-shadow\s*:[^;}]*/g) ?? []).filter((d) => !/:\s*none\s*$/.test(d));
      expect(bad, f).toEqual([]);
    }
  });

  it("no_shadow_utility_classes_in_src", () => {
    const files = (readdirSync(srcRoot, { recursive: true }) as string[]).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)
    );
    expect(files.length).toBeGreaterThan(0);
    const bad = files.filter((f) => /\bshadow-/.test(readFileSync(join(srcRoot, f), "utf8")));
    expect(bad).toEqual([]);
  });

  it("styles_css_transitions_are_150ms", () => {
    const css = read("styles.css");
    expect(css).not.toContain("0.15s");
    expect(css).not.toMatch(/transition[^;]*box-shadow/);
  });
});
