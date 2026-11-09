import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The scaffold's Tailwind scan emits `.grid` and `.outline` utilities, and its
// styles.css once had a bare `aside` rule that hit every <aside>. jsdom cannot
// see any of that, so this reads the stylesheets themselves (research note §5).

function selectorLists(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const lists: string[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    const prelude = (match[1] ?? "").trim();
    // At-rules and keyframe stops are not selectors.
    if (prelude.startsWith("@") || /^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/.test(prelude)) continue;
    lists.push(prelude);
  }
  return lists;
}

// An `aside` compound with no class, id or attribute, and nothing but bare
// element selectors before it, styles every <aside> on the page.
function isBareAside(selector: string): boolean {
  const compounds = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  for (const compound of compounds) {
    const qualified = /[.#[]/.test(compound);
    if (/^aside(?![\w-])/.test(compound)) return !qualified;
    if (qualified) return false;
  }
  return false;
}

function cssClashes(css: string): string[] {
  const clashes: string[] = [];
  for (const list of selectorLists(css)) {
    for (const selector of list.split(",").map((s) => s.trim())) {
      if (/\.grid(?![\w-])/.test(selector)) clashes.push(`.grid in "${selector}"`);
      if (/\.outline(?![\w-])/.test(selector)) clashes.push(`.outline in "${selector}"`);
      if (isBareAside(selector)) clashes.push(`bare aside in "${selector}"`);
    }
  }
  return clashes;
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), "utf8");

describe("cssClashes", () => {
  it("flags_the_tailwind_names_and_a_bare_aside", () => {
    expect(cssClashes(".grid { display: grid; }")).toHaveLength(1);
    expect(cssClashes(".card .outline:hover { color: red; }")).toHaveLength(1);
    expect(cssClashes("aside { width: 240px; }")).toHaveLength(1);
    expect(cssClashes("aside.collapsed { width: 56px; }")).toHaveLength(0);
    expect(cssClashes("body > aside:hover { width: 56px; }")).toHaveLength(1);
    expect(cssClashes("@media (max-width: 880px) { .x, aside { padding: 0; } }")).toHaveLength(1);
  });

  it("allows_scoped_asides_longer_names_and_the_outline_property", () => {
    expect(cssClashes(".task-view aside { width: 300px; }")).toEqual([]);
    expect(cssClashes(".grid-cell, .outlined { outline: 2px solid; }")).toEqual([]);
    expect(cssClashes("/* .grid aside */ @keyframes spin { from { opacity: 0; } to { opacity: 1; } }")).toEqual([]);
  });
});

describe("the stylesheets", () => {
  it("board_css_has_no_scaffold_clashes", () => {
    expect(cssClashes(read("board.css"))).toEqual([]);
  });

  it("styles_css_has_no_scaffold_clashes", () => {
    expect(cssClashes(read("styles.css"))).toEqual([]);
  });

  it("board_css_defines_the_tokens_with_a_dark_set", () => {
    const css = read("board.css");
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    for (const token of ["--sf-bg", "--sf-surface", "--sf-text", "--sf-muted", "--sf-border", "--sf-accent", "--sf-done", "--sf-focus"]) {
      expect(css, token).toMatch(new RegExp(`${token}:`));
      expect(dark, `dark ${token}`).toMatch(new RegExp(`${token}:`));
    }
    expect(css).toMatch(/--sf-font:[^;]*system-ui/);
    expect(css).toMatch(/--sf-mono:[^;]*monospace/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:[^}]*var\(--sf-focus\)/);
  });
});
