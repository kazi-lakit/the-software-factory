import { describe, expect, it } from "vitest";
import { atPhoneWidth, renderedClasses, rulesAt360, tooWide } from "./phoneWidth";

describe("atPhoneWidth", () => {
  it("atPhoneWidth_sets_360_and_matches_max_width_queries", () => {
    const width = window.innerWidth;
    const matchMedia = window.matchMedia;
    const restore = atPhoneWidth();
    expect(window.innerWidth).toBe(360);
    expect(window.matchMedia("(max-width: 639px)").matches).toBe(true);
    expect(window.matchMedia("(max-width: 360px)").matches).toBe(true);
    expect(window.matchMedia("(max-width: 359px)").matches).toBe(false);
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    restore();
    expect(window.innerWidth).toBe(width);
    expect(window.matchMedia).toBe(matchMedia);
  });
});

describe("rulesAt360", () => {
  it("rulesAt360_keeps_base_and_wide_max_width_blocks_only", () => {
    const css = [
      ".base, .base2 { color: red; }",
      "@media (max-width: 1099px) { .r1099 { color: blue; } }",
      "@media (max-width: 639px) { .r639 { color: green; } }",
      "@media (max-width: 320px) { .r320 { color: pink; } }",
      "@media (min-width: 1024px) { .rmin { color: gray; } }",
      "@media (prefers-reduced-motion: reduce) { .rmotion { transition: none; } }"
    ].join("\n");
    expect(rulesAt360(css).map((r) => r.selector)).toEqual([".base", ".base2", ".r1099", ".r639"]);
  });
});

describe("tooWide", () => {
  it("tooWide_flags_fixed_widths_over_the_limit", () => {
    const css = ".a{width:400px}.b{min-width:329px}.c{flex-basis:500px}.d{flex:1 1 400px}.e{width:300px}";
    const found = tooWide(css, ["a", "b", "c", "d", "e"]);
    expect(found).toHaveLength(4);
    expect(found.join("\n")).toMatch(/^\.a /m);
    expect(found.join("\n")).toMatch(/^\.b /m);
    expect(found.join("\n")).toMatch(/^\.c /m);
    expect(found.join("\n")).toMatch(/^\.d /m);
    expect(found.join("\n")).not.toMatch(/^\.e /m);
  });

  it("tooWide_sums_grid_track_minimums", () => {
    expect(tooWide(".g{grid-template-columns:minmax(260px,1.25fr) repeat(3,minmax(220px,1fr))}", ["g"])).toHaveLength(1);
    expect(tooWide(".h{grid-template-columns:repeat(2,minmax(0,1fr))}", ["h"])).toEqual([]);
  });

  it("tooWide_lets_a_later_media_rule_win", () => {
    const css = ".g{grid-template-columns:repeat(4,minmax(220px,1fr))}\n@media (max-width: 639px){.g{grid-template-columns:1fr}}";
    expect(tooWide(css, ["g"])).toEqual([]);
  });

  it("tooWide_ignores_rules_for_classes_not_rendered", () => {
    expect(tooWide(".a .b{width:400px}", ["b"])).toEqual([]);
  });

  it("tooWide_ignores_overrides_whose_ancestors_are_not_rendered", () => {
    const css = ".sf-x{width:400px}\n@media (max-width: 639px){.sf-settings .sf-x{width:100%}}";
    expect(tooWide(css, ["sf-x"])).toEqual([".sf-x {width: 400px}"]);
    expect(tooWide(css, ["sf-x", "sf-settings"])).toEqual([]);
  });
});

describe("renderedClasses", () => {
  it("renderedClasses_skips_overflow_auto_subtrees", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="sf-pills"><span class="wide"></span></div><p class="ok"></p>';
    const classes = renderedClasses(root, ".sf-pills{overflow-x:auto}");
    expect(classes.has("ok")).toBe(true);
    expect(classes.has("wide")).toBe(false);
    expect(classes.has("sf-pills")).toBe(false);
  });

  it("renderedClasses_uses_the_winning_overflow_value", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="cols"><span class="wide"></span></div>';
    const classes = renderedClasses(root, ".cols{overflow-x:auto}\n@media (max-width: 1023px){.cols{overflow-x:visible}}");
    expect(classes.has("wide")).toBe(true);
  });

  it("renderedClasses_picks_the_winning_overflow_per_element", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="page"><div class="cols"><span class="wide"></span></div></div><div class="cols"><span class="other"></span></div>';
    const classes = renderedClasses(root, ".cols{overflow-x:auto}\n.page .cols{overflow-x:visible}");
    expect(classes.has("wide")).toBe(true);
    expect(classes.has("other")).toBe(false);
  });
});
