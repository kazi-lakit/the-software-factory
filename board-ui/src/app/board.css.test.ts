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

/** Body of the first top-level at-rule whose prelude is exactly `prelude`, by brace counting. */
function atBlock(css: string, prelude: string): string {
  const start = css.indexOf(`${prelude} {`);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return "";
}

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

  it("focus_outlines_use_the_focus_token", () => {
    const outlines = read("board.css").match(/outline:[^;]*;/g) ?? [];
    for (const o of outlines) if (o.includes("var(")) expect(o).toContain("var(--sf-focus)");
  });
});

const labelType = {
  "font-family": "var(--sf-mono)",
  "font-size": "var(--sf-label-size)",
  "letter-spacing": "var(--sf-label-tracking)"
};

describe("board_css_buttons", () => {
  it("button_base_is_outline_label_type", () => {
    const t = tokens(read("board.css"), ".sf-button");
    expect(t.background).toBe("transparent");
    expect(t.border).toBe("1px solid var(--sf-border)");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
    expect(t).toMatchObject(labelType);
    expect(t["line-height"]).toBe("var(--sf-label-line)");
    expect(t.padding).toBe("8px 14px");
    expect(t).not.toHaveProperty("min-height");
  });

  it("button_hover_is_primary_soft_with_underline", () => {
    const t = tokens(read("board.css"), ".sf-button:hover:not(:disabled)");
    expect(t.background).toBe("var(--sf-primary-soft)");
    expect(t.color).toBe("var(--sf-on-primary-soft)");
    expect(t["text-decoration"]).toBe("underline");
  });

  it("button_disabled_keeps_opacity_and_cursor", () => {
    const css = read("board.css");
    const t = tokens(css, ".sf-button:disabled");
    expect(t.opacity).toBe("0.6");
    expect(t.cursor).toBe("not-allowed");
    expect(tokens(css, ".sf-button:hover")).toEqual({});
  });

  it("primary_is_the_only_filled_variant", () => {
    const css = read("board.css");
    const p = tokens(css, ".sf-button-primary");
    expect(p.background).toBe("var(--sf-primary)");
    expect(p["border-color"]).toBe("var(--sf-primary)");
    expect(p.color).toBe("var(--sf-on-primary)");
    const h = tokens(css, ".sf-button-primary:hover:not(:disabled)");
    expect(h.background).toBe("var(--sf-primary-hover)");
    expect(h["border-color"]).toBe("var(--sf-primary-hover)");
    expect(h.color).toBe("var(--sf-on-primary)");
    expect(h["text-decoration"]).toBe("underline");
  });

  it("accent_button_uses_accent_fill", () => {
    const css = read("board.css");
    const a = tokens(css, ".sf-button-accent");
    expect(a.background).toBe("var(--sf-accent)");
    expect(a["border-color"]).toBe("var(--sf-accent)");
    expect(a.color).toBe("var(--sf-on-accent)");
    const h = tokens(css, ".sf-button-accent:hover:not(:disabled)");
    expect(h.background).toBe("var(--sf-accent)");
    expect(h.color).toBe("var(--sf-on-accent)");
    expect(h["text-decoration"]).toBe("underline");
  });

  it("danger_stays_an_outline", () => {
    const d = tokens(read("board.css"), ".sf-button-danger");
    expect(d["border-color"]).toBe("var(--sf-removed)");
    expect(d.color).toBe("var(--sf-removed)");
    expect(d).not.toHaveProperty("background");
  });
});

describe("board_css_chips_badges_inputs", () => {
  it("chip_and_badges_are_transparent_outlined_label_type", () => {
    const css = read("board.css");
    for (const s of [".sf-chip", ".sf-badge", ".sf-paused", ".sf-paused-unknown"]) {
      const t = tokens(css, s);
      expect(t.background, s).toBe("transparent");
      expect(t.border, s).toMatch(/^1px /);
      expect(t, s).toMatchObject(labelType);
      expect(t, s).not.toHaveProperty("font-weight");
    }
  });

  it("waiting_badge_is_accent_text_and_outline", () => {
    const css = read("board.css");
    for (const s of [".sf-badge", ".sf-paused"]) {
      expect(tokens(css, s).color).toBe("var(--sf-accent-text)");
      expect(tokens(css, s).border).toContain("var(--sf-accent)");
    }
  });

  it("input_is_transparent_outlined_3px", () => {
    const t = tokens(read("board.css"), ".sf-input");
    expect(t.background).toBe("transparent");
    expect(t.border).toBe("1px solid var(--sf-border)");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
  });
});

describe("board_css_select", () => {
  it("select_is_native_appearance_none_34px_label_type", () => {
    const t = tokens(read("board.css"), ".sf-select");
    expect(t.appearance).toBe("none");
    expect(t["-webkit-appearance"]).toBe("none");
    expect(t["background-color"]).toBe("transparent");
    expect(t.border).toBe("1px solid var(--sf-border)");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
    expect(t.height).toBe("34px");
    expect(t["min-height"]).toBe("34px");
    expect(t.padding).toBe("0 28px 0 10px");
    expect(t).toMatchObject(labelType);
    expect(t).not.toHaveProperty("outline");
  });

  it("select_has_exactly_one_chevron", () => {
    const css = read("board.css");
    const t = tokens(css, ".sf-select");
    expect(t["background-image"]?.match(/linear-gradient\(/g)).toHaveLength(2);
    expect(t["background-image"]).toContain("currentColor");
    expect(t["background-repeat"]).toBe("no-repeat");
    const lists = selectorLists(css).join("\n");
    expect(lists).not.toMatch(/\.sf-select::after/);
    expect(lists).not.toMatch(/\.sf-(field|inline-field)::after/);
  });

  it("select_hover_sets_background_color_only", () => {
    const t = tokens(read("board.css"), ".sf-select:hover:not(:disabled)");
    expect(t["background-color"]).toBe("var(--sf-primary-soft)");
    expect(Object.keys(t)).not.toContain("background");
    expect(Object.keys(t)).not.toContain("background-image");
  });

  it("mono_select_keeps_label_size_and_height", () => {
    const css = read("board.css");
    const t = tokens(css, ".sf-select.sf-mono");
    for (const k of ["font-size", "letter-spacing", "height"]) expect(t).not.toHaveProperty(k);
    expect(css.indexOf(".sf-select {")).toBeGreaterThan(css.indexOf(".sf-mono {"));
  });

  it("select_options_are_readable", () => {
    const t = tokens(read("board.css"), ".sf-select option");
    expect(t.color).toBe("var(--sf-text)");
    expect(t["background-color"]).toBe("var(--sf-surface)");
  });

  it("labels_beside_selects_are_label_type_muted", () => {
    const css = read("board.css");
    for (const s of [".sf-field > span,\n.sf-inline-field > span,\n.sf-doc-controls label", ".sf-fieldset legend"]) {
      const t = tokens(css, s);
      expect(t.color, s).toBe("var(--sf-muted)");
      expect(t, s).toMatchObject(labelType);
    }
  });
});

describe("board_css_motion", () => {
  it("shared_controls_transition_colours_in_150ms", () => {
    const css = read("board.css");
    const sel = [".sf-button", ".sf-select", ".sf-input", ".sf-chip", ".sf-badge", ".sf-view-link", ".sf-tab", ".sf-account"];
    const list = selectorLists(css).find((l) => sel.every((s) => l.split(",").map((x) => x.trim()).includes(s)));
    expect(list).toBeDefined();
    expect(tokens(css, list ?? "").transition).toBe(
      "background-color 150ms ease, border-color 150ms ease, color 150ms ease"
    );
  });

  it("reduced_motion_block_zeroes_transitions", () => {
    const css = read("board.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(tokens(css, "*,\n  *::before,\n  *::after")["transition-duration"]).toBe("0s !important");
  });

  it("switch_thumb_reduced_motion_block_still_present", () => {
    expect(tokens(read("board.css"), ".sf-switch input::before").transition).toBe("transform 120ms ease");
  });
});

const labelLine = { ...labelType, "line-height": "var(--sf-label-line)" };

describe("board_css_topbar", () => {
  it("topbar_is_transparent_with_one_chrome_border_hairline", () => {
    const t = tokens(read("board.css"), ".sf-topbar");
    expect(t.background).toBe("transparent");
    expect(t["border-bottom"]).toBe("1px solid var(--sf-chrome-border)");
    for (const k of ["border", "border-top", "border-left", "border-right", "box-shadow"]) expect(t).not.toHaveProperty(k);
  });

  it("topbar_height_token_is_52px", () => {
    const css = read("board.css");
    expect(tokens(css, ":root")["--sf-bar-height"]).toBe("52px");
    expect(tokens(css, ".sf-topbar")["min-height"]).toBe("var(--sf-bar-height)");
  });

  it("project_name_uses_label_type", () => {
    const t = tokens(read("board.css"), ".sf-project");
    expect(t).toMatchObject(labelLine);
    expect(t).not.toHaveProperty("font-weight");
    expect(t.color).toBe("var(--sf-text)");
  });

  it("nav_links_are_label_type_muted", () => {
    const t = tokens(read("board.css"), ".sf-view-link");
    expect(t).toMatchObject(labelLine);
    expect(t.color).toBe("var(--sf-muted)");
    expect(t["border-bottom"]).toBe("2px solid transparent");
  });

  it("nav_hover_underlines", () => {
    expect(tokens(read("board.css"), ".sf-view-link:hover")["text-decoration"]).toBe("underline");
  });

  it("current_nav_link_is_text_colour_with_2px_underline", () => {
    const t = tokens(read("board.css"), '.sf-view-link[aria-current="page"]');
    expect(t.color).toBe("var(--sf-text)");
    expect(t["border-bottom-color"]).toBe("var(--sf-text)");
    expect(t).not.toHaveProperty("font-weight");
  });
});

describe("board_css_account_pill", () => {
  it("account_pill_is_an_outlined_label_type_pill", () => {
    const t = tokens(read("board.css"), ".sf-account");
    expect(t.background).toBe("transparent");
    expect(t.border).toBe("1px solid var(--sf-border)");
    expect(t["border-radius"]).toBe("999px");
    expect(t).toMatchObject(labelLine);
    expect(t.color).toBe("var(--sf-text)");
    expect(t["white-space"]).toBe("nowrap");
  });

  it("account_pill_hover_is_primary_soft_with_underline", () => {
    const t = tokens(read("board.css"), ".sf-account:hover");
    expect(t.background).toBe("var(--sf-primary-soft)");
    expect(t.color).toBe("var(--sf-on-primary-soft)");
    expect(t["text-decoration"]).toBe("underline");
  });

  it("avatar_is_a_22px_circle_in_primary_soft", () => {
    const t = tokens(read("board.css"), ".sf-avatar");
    expect(t.width).toBe("22px");
    expect(t.height).toBe("22px");
    expect(t["border-radius"]).toBe("999px");
    expect(t.background).toBe("var(--sf-primary-soft)");
    expect(t.color).toBe("var(--sf-on-primary-soft)");
    expect(t["font-size"]).toBe("var(--sf-label-size)");
  });

  it("account_name_truncates_at_16ch", () => {
    const t = tokens(read("board.css"), ".sf-account-name");
    expect(t["max-width"]).toBe("16ch");
    expect(t.overflow).toBe("hidden");
    expect(t["text-overflow"]).toBe("ellipsis");
    expect(t["white-space"]).toBe("nowrap");
  });

  it("topbar_end_has_12px_gap_and_auto_margin", () => {
    const t = tokens(read("board.css"), ".sf-topbar-end");
    expect(t.gap).toBe("12px");
    expect(t["margin-left"]).toBe("auto");
  });
});

describe("board_css_task_card", () => {
  const css = () => read("board.css");
  const t = (selector: string) => tokens(css(), selector);

  it("card_is_surface_1px_border_3px_radius_8px_padding", () => {
    expect(t(".sf-card")).toMatchObject({
      background: "var(--sf-surface)",
      border: "1px solid var(--sf-border)",
      "border-radius": "var(--sf-radius)",
      padding: "8px"
    });
  });

  it("card_id_uses_label_type", () => {
    expect(t(".sf-card-id")).toMatchObject({ ...labelType, color: "var(--sf-muted)" });
  });

  it("card_status_chip_is_outlined_label_type", () => {
    expect(t(".sf-card-status")).toMatchObject({ ...labelType, background: "transparent" });
    expect(t(".sf-card-status").border).toContain("1px");
    expect(t(".sf-card-status")["font-weight"]).toBeUndefined();
    expect(t(".sf-card-status-waiting").border).toContain("var(--sf-accent)");
    expect(t(".sf-card-status-waiting").color).toBe("var(--sf-accent-text)");
  });

  it("title_is_text_colour_weight_500_underlined_on_hover_and_focus", () => {
    expect(t(".sf-card-link")).toMatchObject({ color: "var(--sf-text)", "font-weight": "500", "text-decoration": "none", "overflow-wrap": "anywhere" });
    expect(t(".sf-card-link:hover")["text-decoration"]).toBe("underline");
    expect(t(".sf-card-link:focus-visible")["text-decoration"]).toBe("underline");
    expect(t(".sf-card-link::after")).toMatchObject({ position: "absolute", inset: "0" });
  });

  it("steps_are_14x4px_in_the_four_state_colours", () => {
    expect(t(".sf-step")).toMatchObject({ width: "14px", height: "4px" });
    expect(t('.sf-step[data-state="done"]').background).toBe("var(--sf-progress)");
    expect(t('.sf-step[data-state="current"]').background).toBe("var(--sf-muted)");
    expect(t('.sf-step[data-state="waiting"]').background).toBe("var(--sf-accent)");
    expect(t('.sf-step[data-state="todo"]').background).toBe("var(--sf-border)");
  });

  it("done_cards_use_done_colours_for_chip_and_steps", () => {
    expect(t(".sf-card-muted .sf-card-status")).toMatchObject({ color: "var(--sf-done)", "border-color": "var(--sf-done)" });
    expect(t('.sf-card-muted .sf-step[data-state="done"]').background).toBe("var(--sf-done)");
    expect(t(".sf-card-muted")).toMatchObject({ background: "var(--sf-done-soft)", color: "var(--sf-done)" });
  });

  it("question_is_one_line_with_a_dashed_outline", () => {
    expect(t(".sf-card-question")).toMatchObject({
      border: "1px dashed var(--sf-border)", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis"
    });
  });

  it("cta_is_a_small_outlined_accent_link_above_the_stretched_link", () => {
    expect(t(".sf-card-cta")).toMatchObject({
      ...labelType,
      background: "transparent",
      border: "1px solid var(--sf-accent)",
      color: "var(--sf-accent-text)",
      position: "relative",
      "z-index": "1",
      "align-self": "flex-start",
      padding: "2px 8px"
    });
    expect(t(".sf-card-cta").outline).toBeUndefined();
    expect(t(".sf-card-cta:hover")["text-decoration"]).toBe("underline");
  });

  it("waiting_card_border_is_accent_on_all_sides", () => {
    expect(t(".sf-card-needs-you")["border-color"]).toBe("var(--sf-accent)");
    expect(t(".sf-card-needs-you")["border-left"]).toBeUndefined();
  });

  it("card_rules_have_no_raw_colours_or_shadows", () => {
    const all = css();
    const block = all.slice(all.indexOf(".sf-card {"), all.indexOf("/* Task */"));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|box-shadow/i);
  });

  it("meta_line_wraps", () => {
    expect(t(".sf-card-meta")["flex-wrap"]).toBe("wrap");
  });
});

describe("board_css_lanes", () => {
  const css = () => read("board.css");
  it("lanes_grid_is_five_equal_columns_full_width", () => {
    const t = tokens(css(), ".sf-lanes");
    expect(t["display"]).toBe("grid");
    expect(t["grid-template-columns"]).toBe("repeat(5, minmax(0, 1fr))");
    expect(t["gap"]).toBe("10px");
    expect(t["align-items"]).toBe("start");
  });
  it("lane_frame_is_1px_chrome_border_transparent_8px_3px", () => {
    const t = tokens(css(), ".sf-lane");
    expect(t["border"]).toBe("1px solid var(--sf-chrome-border)");
    expect(t["background"]).toBe("transparent");
    expect(t["padding"]).toBe("8px");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
    expect(t["min-width"]).toBe("0");
    expect(t["box-shadow"]).toBeUndefined();
  });
  it("needs_you_lane_has_accent_border_and_a_stronger_top_wash", () => {
    const t = tokens(css(), ".sf-lane-needs-you");
    expect(t["border-color"]).toBe("var(--sf-accent)");
    expect(t["background"]).toContain("linear-gradient(to bottom");
    expect((t["background"]?.match(/var\(--sf-needs-tint\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(t["background"]).not.toMatch(/#|rgb/);
  });
  it("lane_name_hint_count_styles", () => {
    const hint = tokens(css(), ".sf-lane-hint");
    expect(hint["color"]).toBe("var(--sf-muted)");
    expect(hint["white-space"]).toBe("nowrap");
    expect(hint["overflow"]).toBe("hidden");
    expect(hint["text-overflow"]).toBe("ellipsis");
    expect(tokens(css(), ".sf-lane-name")["margin"]).toBe("0");
  });
  it("segmented_switch_styles", () => {
    const t = tokens(css(), ".sf-segment");
    expect(t["border"]).toBe("1px solid var(--sf-border)");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
    expect(t["background"]).toBe("transparent");
    expect(t["font-family"]).toBe("var(--sf-mono)");
    expect(t["font-size"]).toBe("var(--sf-label-size)");
    expect(t["letter-spacing"]).toBe("var(--sf-label-tracking)");
    const on = tokens(css(), '.sf-segment[aria-pressed="true"]');
    expect(on["background"]).toBe("var(--sf-primary-soft)");
    expect(on["color"]).toBe("var(--sf-on-primary-soft)");
  });
  it("lanes_wrap_to_two_columns_below_1100px_and_one_below_640px", () => {
    const raw = css();
    const two = raw.indexOf("@media (max-width: 1099px)");
    const one = raw.indexOf("@media (max-width: 639px)");
    expect(two).toBeGreaterThan(-1);
    expect(one).toBeGreaterThan(two);
    expect(raw.slice(two, one)).toMatch(/\.sf-lanes\s*\{[^}]*repeat\(2,/);
    expect(raw.slice(one, one + 300)).toMatch(/\.sf-lanes\s*\{[^}]*1fr/);
    expect(raw).toMatch(/@media \(max-width: 1023px\)\s*\{\s*\.sf-columns/);
  });
  it("all_stages_column_frame", () => {
    const t = tokens(css(), ".sf-column");
    expect(t["border"]).toBe("1px solid var(--sf-chrome-border)");
    expect(t["border-radius"]).toBe("var(--sf-radius)");
    expect(t["background"]).toBe("transparent");
    expect(t["flex"]).toBe("0 0 216px");
    expect(t["padding"]).toBe("8px");
    const strip = tokens(css(), ".sf-columns");
    expect(strip["gap"]).toBe("10px");
    expect(strip["overflow-x"]).toBe("auto");
  });
  it("all_stages_needs_you_columns", () => {
    const t = tokens(css(), ".sf-column-needs-you");
    expect(t["border-color"]).toBe("var(--sf-accent)");
    expect(t["background"]).toContain("var(--sf-needs-tint)");
    expect(JSON.stringify(tokens(css(), ".sf-column"))).not.toContain("--sf-accent");
  });
  it("all_stages_collapsed_width", () => {
    expect(tokens(css(), ".sf-column-collapsed")["flex-basis"]).toBe("140px");
  });
  it("all_stages_hint_is_one_clipped_line", () => {
    const t = tokens(css(), ".sf-columns-hint");
    expect(t["color"]).toBe("var(--sf-muted)");
    expect(t["font-size"]).toBe("var(--sf-size-small)");
    expect(t["white-space"]).toBe("nowrap");
    expect(t["overflow"]).toBe("hidden");
    expect(t["text-overflow"]).toBe("ellipsis");
  });
  it("all_stages_rules_have_no_shadow_or_raw_colour", () => {
    const raw = css();
    const start = raw.indexOf(".sf-columns {");
    const slice = raw.slice(start, raw.indexOf("/* Lanes view */", start));
    expect(slice.length).toBeGreaterThan(100);
    const hint = raw.slice(raw.indexOf(".sf-columns-hint {"));
    for (const part of [slice, hint.slice(0, hint.indexOf("}"))]) {
      expect(part).not.toMatch(/box-shadow|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});

describe("board_css_task_page", () => {
  const css = read("board.css");
  const t = (selector: string) => tokens(css, selector);

  it("task_title_is_28px_bold_tight", () => {
    expect(t(".sf-task-header h2")).toMatchObject({
      color: "var(--sf-text)", "font-size": "28px", "font-weight": "700", "letter-spacing": "-0.02em"
    });
  });

  it("task_meta_is_muted", () => {
    expect(t(".sf-task-meta").color).toBe("var(--sf-muted)");
  });

  it("stepper_labels_use_label_type_and_waiting_uses_accent_text", () => {
    expect(t(".sf-stepper-label")).toMatchObject({ ...labelType, color: "var(--sf-muted)" });
    expect(t(".sf-stepper-item-waiting .sf-stepper-label")).toMatchObject({ color: "var(--sf-accent-text)", "font-weight": "700" });
  });

  it("stepper_bars_are_fill_width", () => {
    expect(t(".sf-stepper .sf-step").width).toBe("100%");
    expect(t(".sf-step")).toMatchObject({ width: "14px", height: "4px" });
  });

  it("decision_panel_has_accent_border_on_all_sides", () => {
    const needs = t(".sf-panel-needs-you");
    expect(needs["border-color"]).toBe("var(--sf-accent)");
    expect(needs["border-left"]).toBeUndefined();
    expect(t(".sf-panel").background).toBe("var(--sf-surface)");
    expect(t(".sf-panel").border).toBe("1px solid var(--sf-border)");
  });

  it("details_terms_are_label_type_muted", () => {
    expect(t(".sf-details dt")).toMatchObject({ ...labelType, color: "var(--sf-muted)" });
    expect(t(".sf-details dd").margin).toBe("0");
  });

  it("task_body_is_two_to_one_grid_with_16px_gap", () => {
    expect(t(".sf-task-body")).toMatchObject({ display: "grid", gap: "16px", "grid-template-columns": "minmax(0, 2fr) minmax(0, 1fr)" });
    expect(t(".sf-task-body > *")["min-width"]).toBe("0");
  });

  it("task_body_stacks_below_1100px", () => {
    const start = css.indexOf("@media (max-width: 1099px)");
    const block = css.slice(start, css.indexOf("@media (max-width: 639px)", start));
    expect(block).toMatch(/\.sf-task-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("task_rules_have_no_shadow_or_raw_colour_or_literal_transitions", () => {
    const slice = css.slice(css.indexOf("/* Task */"), css.indexOf("/* Docs are markdown"));
    expect(slice).toContain(".sf-task-body");
    expect(slice).not.toMatch(/box-shadow|#[0-9a-f]{3,8}\b|rgba?\(|transition/i);
  });
});

describe("board_css_t16_forms_tables_tabs", () => {
  const css = read("board.css");
  const t = (selector: string) => tokens(css, selector);
  const title = { color: "var(--sf-text)", "font-size": "28px", "font-weight": "700", "letter-spacing": "-0.02em", margin: "0" };

  it("page_title_is_28px_bold_tight", () => {
    expect(t(".sf-page-title")).toMatchObject(title);
  });

  it("page_title_beats_view_headings", () => {
    expect(t(".sf-view h2.sf-page-title")).toMatchObject(title);
    expect(t(".sf-view h3.sf-page-title")).toMatchObject(title);
  });

  it("table_wrap_is_surface_panel", () => {
    expect(t(".sf-table-wrap")).toMatchObject({
      background: "var(--sf-surface)", border: "1px solid var(--sf-border)", "border-radius": "var(--sf-radius)", "overflow-x": "auto"
    });
  });

  it("table_heads_are_label_type", () => {
    expect(t(".sf-table th")).toMatchObject({
      ...labelLine, color: "var(--sf-muted)", padding: "8px 12px", "border-bottom": "1px solid var(--sf-chrome-border)"
    });
    expect(t(".sf-table")["border-collapse"]).toBe("collapse");
  });

  it("table_rows_have_hairlines", () => {
    expect(t(".sf-table tbody tr")["border-bottom"]).toBe("1px solid var(--sf-chrome-border)");
    expect(t(".sf-table tbody tr:last-child")["border-bottom"]).toBe("0");
    expect(t(".sf-table tbody tr:hover").background).toBe("var(--sf-surface-sunk)");
  });

  it("table_cells_pad_8_12", () => {
    expect(t(".sf-table td").padding).toBe("8px 12px");
  });

  it("field_label_is_label_type_muted", () => {
    expect(t(".sf-field-label")).toMatchObject({ ...labelLine, color: "var(--sf-muted)" });
  });

  it("tab_is_label_type_muted_with_transparent_2px_underline", () => {
    const tab = t(".sf-tab");
    expect(tab).toMatchObject({ ...labelLine, color: "var(--sf-muted)", "border-bottom": "2px solid transparent" });
    expect(tab.font).toBeUndefined();
  });

  it("selected_tab_has_text_underline", () => {
    expect(t('.sf-tab[aria-selected="true"]')).toMatchObject({ color: "var(--sf-text)", "border-bottom-color": "var(--sf-text)" });
  });

  it("tab_hover_underlines_and_row_uses_chrome_border", () => {
    expect(t(".sf-tab:hover")["text-decoration"]).toBe("underline");
    expect(t(".sf-tabs")["border-bottom"]).toBe("1px solid var(--sf-chrome-border)");
    expect(t(".sf-tab:focus-visible").outline).toBe("2px solid var(--sf-focus)");
  });

  it("switch_on_is_primary_with_on_primary_thumb", () => {
    expect(t(".sf-switch input:checked")).toMatchObject({ background: "var(--sf-primary)", "border-color": "var(--sf-primary)" });
    expect(t(".sf-switch input:checked::before")).toMatchObject({
      background: "var(--sf-on-primary)", "border-color": "var(--sf-on-primary)", transform: "translateX(12px)"
    });
    expect(t(".sf-switch input:disabled").opacity).toBe("0.6");
  });

  it("t16_rules_use_no_hardcoded_colours", () => {
    const selectors = [
      ".sf-page-title", ".sf-view h2.sf-page-title", ".sf-view h3.sf-page-title", ".sf-table-wrap", ".sf-table th", ".sf-table td",
      ".sf-table tbody tr", ".sf-field-label", ".sf-tab", '.sf-tab[aria-selected="true"]', ".sf-tabs",
      ".sf-switch input:checked", ".sf-switch input:checked::before"
    ];
    for (const s of selectors) {
      for (const v of Object.values(t(s))) expect(v, s).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    }
  });
});

describe("board_css_question_and_radio_cards", () => {
  it("question_title_is_20px", () => {
    const title = tokens(read("board.css"), ".sf-view h3.sf-question-title");
    expect(title["font-size"]).toBe("20px");
    expect(title.margin).toBe("0");
  });

  it("radio_card_uses_only_tokens_and_focus_ring", () => {
    const css = read("board.css");
    const selected = tokens(css, ".sf-radio-card-selected");
    expect(selected["border-color"]).toBe("var(--sf-accent)");
    expect(selected.background).toBe("var(--sf-accent-soft)");
    expect(tokens(css, ".sf-radio-card:focus-within").outline).toBe("2px solid var(--sf-focus)");
    expect(tokens(css, ".sf-radio-card").border).toBe("1px solid var(--sf-border)");
    const why = tokens(css, ".sf-radio-why");
    expect(why["white-space"]).toBe("nowrap");
    expect(why["text-overflow"]).toBe("ellipsis");
  });
});

// T-20: in All stages on desktop the shell is the window height and the column strip is the one
// scroll container, so its horizontal scrollbar sits on the bottom edge of the window.
describe("board_css_all_stages_window_fit", () => {
  const DESK = "@media (min-width: 1024px)";
  const block = () => atBlock(read("board.css"), DESK);

  it("desktop_block_exists_once_and_sits_before_the_phone_block", () => {
    const css = read("board.css");
    expect(css.split(DESK).length - 1).toBe(1);
    const at = css.indexOf(DESK);
    expect(at).toBeGreaterThan(css.indexOf("@media (max-width: 1023px)"));
    expect(at).toBeLessThan(css.lastIndexOf("@media (max-width: 639px)"));
  });

  it("shell_is_exactly_the_window_height_in_all_stages", () => {
    const app = tokens(block(), ".sf-app:has(.sf-view-stages)");
    expect(app.height).toBe("100dvh");
    expect(app.overflow).toBe("hidden");
    expect(block()).toMatch(/\.sf-app:has\(\.sf-view-stages\)\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/);
  });

  it("main_fits_and_has_no_bottom_padding_in_all_stages", () => {
    expect(tokens(block(), ".sf-app:has(.sf-view-stages) .sf-main")).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      "min-height": "0",
      "overflow-x": "hidden",
      "overflow-y": "auto",
      "padding-bottom": "0",
    });
  });

  it("view_is_a_column_that_fills_main", () => {
    expect(tokens(block(), ".sf-view.sf-view-stages")).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      flex: "1 0 auto",
      "min-height": "0",
      "min-width": "0",
    });
  });

  it("chrome_keeps_its_natural_height", () => {
    expect(tokens(block(), ".sf-view-stages > *")["flex-shrink"]).toBe("0");
  });

  it("strip_is_the_one_scroll_container_with_a_240px_floor", () => {
    expect(tokens(block(), ".sf-view-stages > .sf-columns")).toMatchObject({
      flex: "1 1 0",
      "min-height": "240px",
      overflow: "auto",
    });
    expect(tokens(read("board.css"), ".sf-columns")).toMatchObject({
      "overflow-x": "auto",
      gap: "10px",
      "padding-bottom": "8px",
    });
  });

  it("every_desktop_rule_is_scoped_to_all_stages", () => {
    const lists = selectorLists(block());
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      for (const selector of list.split(",").map((s) => s.trim())) expect(selector).toContain("sf-view-stages");
    }
  });

  it("desktop_block_has_no_raw_colour_shadow_or_scaffold_clash", () => {
    const css = block();
    expect(css).not.toBe("");
    expect(css).not.toMatch(/box-shadow|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(cssClashes(css)).toEqual([]);
    const classes = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? "");
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.every((name) => name.startsWith("sf-"))).toBe(true);
  });

  it("stacking_below_1024px_is_unchanged", () => {
    const css = read("board.css");
    const narrow = atBlock(css, "@media (max-width: 1023px)");
    expect(tokens(narrow, ".sf-columns")).toEqual({ "flex-direction": "column", "overflow-x": "visible" });
    expect(tokens(narrow, ".sf-column,\n  .sf-column-collapsed")).toMatchObject({ "flex-basis": "auto", width: "100%" });
    expect(css).toMatch(/@media \(max-width: 1023px\)\s*\{\s*\.sf-columns/);
  });

  it("column_sizes_and_hint_are_unchanged", () => {
    const css = read("board.css");
    expect(tokens(css, ".sf-column").flex).toBe("0 0 216px");
    expect(tokens(css, ".sf-column-collapsed")["flex-basis"]).toBe("140px");
    expect(tokens(css, ".sf-columns-hint")["white-space"]).toBe("nowrap");
    for (const list of selectorLists(block())) {
      for (const selector of list.split(",").map((s) => s.trim())) {
        expect(selector).not.toMatch(/\.sf-column$|\.sf-column-collapsed$|\.sf-columns-hint$/);
      }
    }
  });
});
