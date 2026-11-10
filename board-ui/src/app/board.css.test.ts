import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokens } from "../test/cssTokens";

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

  it("styles_css_dark_block_does_not_use_prefers_color_scheme", () => {
    const css = read("styles.css");
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).toContain(':root:not([data-theme="light"])');
  });
});

const DARK: Record<string, string> = {
  "--sf-bg": "#080c0d",
  "--sf-surface": "#0b1112",
  "--sf-surface-sunk": "#0a0f10",
  "--sf-text": "#e7efee",
  "--sf-muted": "#9db0af",
  "--sf-border": "rgba(157,176,175,0.45)",
  "--sf-accent": "#5cc8cd",
  "--sf-accent-soft": "#0c2224",
  "--sf-accent-text": "#5cc8cd",
  "--sf-on-accent": "#080c0d",
  "--sf-done": "#8a9b9a",
  "--sf-done-soft": "#0a0f10",
  "--sf-focus": "#5cc8cd",
  "--sf-added": "#7ee2a8",
  "--sf-added-soft": "#0d2216",
  "--sf-removed": "#f2a3a3",
  "--sf-removed-soft": "#2a1414",
  "--sf-primary": "#9db0af",
  "--sf-primary-hover": "#b4c4c3",
  "--sf-on-primary": "#080c0d",
  "--sf-primary-soft": "#16201f",
  "--sf-on-primary-soft": "#e7efee",
  "--sf-progress": "#9ea7ba",
  "--sf-chrome-border": "rgba(157,176,175,0.25)",
  "--sf-needs-tint": "rgba(92,205,160,0.08)"
};

const LIGHT: Record<string, string> = {
  "--sf-bg": "#e7efee",
  "--sf-surface": "#f4f8f7",
  "--sf-surface-sunk": "#dde7e6",
  "--sf-text": "#0b1112",
  "--sf-muted": "#3e5150",
  "--sf-border": "rgba(11,17,18,0.3)",
  "--sf-accent": "#0e7c82",
  "--sf-accent-soft": "#d2eef0",
  "--sf-accent-text": "#0a6368",
  "--sf-on-accent": "#ffffff",
  "--sf-primary": "#0b1112",
  "--sf-primary-hover": "#22302f",
  "--sf-on-primary": "#e7efee",
  "--sf-primary-soft": "#d0dcdb",
  "--sf-on-primary-soft": "#0b1112",
  "--sf-progress": "#6b7488",
  "--sf-done": "#4d5c5b",
  "--sf-done-soft": "#e0e8e7",
  "--sf-focus": "#0b1112",
  "--sf-chrome-border": "rgba(11,17,18,0.2)",
  "--sf-added": "#166534",
  "--sf-added-soft": "#dcfce7",
  "--sf-removed": "#b91c1c",
  "--sf-removed-soft": "#fee2e2",
  "--sf-needs-tint": "rgba(14,124,100,0.07)"
};

const compact = (v: string | undefined) => (v ?? "").replace(/\s+/g, "");

describe("board_css_theme_tokens", () => {
  it("dark_defaults_on_root_match_the_spec", () => {
    const t = tokens(read("board.css"), ":root");
    for (const [k, v] of Object.entries(DARK)) expect(compact(t[k]), k).toBe(compact(v));
  });

  it("light_block_on_root_data_theme_light_matches_the_spec", () => {
    const t = tokens(read("board.css"), ':root[data-theme="light"]');
    for (const [k, v] of Object.entries(LIGHT)) expect(compact(t[k]), k).toBe(compact(v));
  });

  it("no_prefers_color_scheme_anywhere_in_board_css", () => {
    expect(read("board.css")).not.toContain("prefers-color-scheme");
  });

  it("radius_is_3px_and_type_tokens_set", () => {
    const css = read("board.css");
    const t = tokens(css, ":root");
    expect(t["--sf-radius"]).toBe("3px");
    expect(t["--sf-size"]).toBe("16px");
    expect(t["--sf-label-size"]).toBe("12px");
    expect(t["--sf-label-line"]).toBe("16px");
    expect(t["--sf-label-tracking"]).toBe("0.16em");
    expect(t["--sf-mono"]).toMatch(/^SFMono-Regular/);
    expect(tokens(css, "body")["line-height"]).toBe("24px");
  });

  it("label_class_uses_mono_label_tokens", () => {
    const l = tokens(read("board.css"), ".sf-label");
    expect(l["font-family"]).toBe("var(--sf-mono)");
    expect(l["font-size"]).toBe("var(--sf-label-size)");
    expect(l["line-height"]).toBe("var(--sf-label-line)");
    expect(l["letter-spacing"]).toBe("var(--sf-label-tracking)");
  });

  it("body_background_is_dot_grid_over_glow_in_both_themes", () => {
    const css = compact(read("board.css"));
    for (const s of [
      "rgba(157,176,175,0.045)",
      "0.8px",
      "16px16px",
      "circleat63%42%,#0e1718,#0a0f10,#080c0d",
      "rgba(11,17,18,0.035)",
      "#e7efee",
      "color-scheme:dark",
      "color-scheme:light"
    ])
      expect(css, s).toContain(s);
  });

  it("accent_text_replaces_accent_for_paused_and_badge", () => {
    const css = read("board.css");
    expect(tokens(css, ".sf-paused").color).toBe("var(--sf-accent-text)");
    expect(tokens(css, ".sf-badge").color).toBe("var(--sf-accent-text)");
  });
});
