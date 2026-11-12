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

  it("styles_css_does_not_use_prefers_color_scheme", () => {
    const css = read("styles.css");
    expect(css).not.toContain("prefers-color-scheme");
  });
});

// Design invariants protect usability without freezing the retired BAK component geometry.
describe("Breakwater component system", () => {
  const css = read("board.css");
  const t = (selector: string) => tokens(css, selector);
  it("uses the supplied display and operational typefaces with subtly rounded surfaces", () => {
    expect(t(":root")["--sf-display"]).toContain("Instrument Serif");
    expect(t(":root")["--sf-mono"]).toContain("DM Mono");
    expect(t(":root")["--sf-radius"]).toBe("6px");
    expect(t(":root")["--sf-label-tracking"]).toBe("2.2px");
    expect(t(".sf-label")["font-weight"]).toBe("500");
    expect(t(":root")["--sf-accent"]).toBe("#4693c3");
    expect(t(':root[data-theme="light"]')["--sf-bg"]).toBe("#eef2f3");
  });
  it("keeps control targets at least 44px and invalid fields distinct", () => {
    for (const selector of [".sf-button", ".sf-input", ".sf-select"]) expect(parseFloat(t(selector)["min-height"] ?? "0")).toBeGreaterThanOrEqual(44);
    expect(t('.sf-input[aria-invalid="true"]')["border-color"]).toBe("var(--sf-removed)");
    expect(t(":focus-visible").outline).toContain("var(--sf-focus)");
  });
  it("distinguishes primary, decision and destructive actions", () => {
    expect(t(".sf-button-primary").background).toBe("var(--sf-primary)");
    expect(t(".sf-button-primary").color).toBe("var(--sf-on-primary)");
    expect(t(".sf-button-accent").background).toBe("var(--sf-accent)");
    expect(t(".sf-button-accent").color).toBe("var(--sf-on-accent)");
    expect(t(".sf-button-danger").color).toBe("var(--sf-removed)");
  });
  it("wraps decision explanations and contains document and table overflow", () => {
    expect(t(".sf-radio-why")["white-space"]).toBe("normal");
    expect(t(".sf-table-wrap")["overflow-x"]).toBe("auto");
    expect(t(".sf-doc-body")["overflow-wrap"]).toBe("anywhere");
    expect(t(".sf-task-tabs .sf-tabs")["overflow-x"]).toBe("auto");
  });
  it("retains mobile and desktop stage scrolling and reduced-motion support", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("transition-duration: 0s !important");
    expect(css).toContain("background-color 220ms ease");
    expect(css).toContain(".sf-view-stages > .sf-columns");
    expect(t(".sf-columns")["overflow-x"]).toBe("auto");
  });
  it("uses layered navigation and a keyboard skip link", () => {
    expect(t(".sf-sidebar").position).toBe("fixed");
    expect(t(".sf-topbar").position).toBe("sticky");
    expect(t(".sf-skip-link:focus").top).toBe("12px");
  });
  it("makes save feedback visible on a readable semantic surface", () => {
    expect(t(".sf-feedback").background).toBe("var(--sf-accent-soft)");
    expect(t(".sf-feedback").color).toBe("var(--sf-accent-text)");
    expect(t(".sf-feedback").display).not.toBe("none");
  });
});

describe("shared-control style isolation", () => {
  const css = read("board.css");
  it("does not leak tab geometry through the shared transition rule", () => {
    const group = css.match(/\.sf-button,\s*\.sf-select,[^{]+\{([^}]+)\}/)?.[1];
    expect(group).toBeDefined();
    expect(group).not.toMatch(/\b(padding|min-height|letter-spacing)\s*:/);
  });
  it("contains absolutely positioned accessibility text inside scrollable tables", () => {
    expect(tokens(css, ".sf-table-wrap").position).toBe("relative");
  });
});
