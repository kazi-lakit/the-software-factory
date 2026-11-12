import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseRules, outranked, phoneBlockInfo, phoneOutranked, phoneRules, specificity } from "../test/cssMedia";
import { tokens } from "../test/cssTokens";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "board.css"), "utf8");

/** Declarations of the phone rule whose selector is exactly `selector` (later rules win on a repeated property). */
function phone(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of phoneRules(css)) if (rule.selector === selector) Object.assign(out, rule.decls);
  return out;
}

describe("phone layout tokens", () => {
  it("defines the phone tokens", () => {
    const root = tokens(css, ":root");
    expect(root["--sf-tabbar-height"]).toBe("56px");
    expect(root["--sf-actionbar-button"]).toBe("48px");
    expect(root["--sf-input-height"]).toBe("44px");
    expect(root["--sf-input-font"]).toBe("16px");
    expect(root["--sf-bar-height"]).toBe("72px");
  });
});

describe("phone top bar and tab bar", () => {
  it("phone top bar is compact", () => {
    expect(phone(".sf-topbar")["min-height"]).toBe("48px");
    expect(phone(".sf-topbar").padding).toBe("0 12px");
    expect(tokens(css, ".sf-topbar")["min-height"]).toBe("72px");
  });

  it("phone top bar keeps the base opaque background", () => {
    const t = phone(".sf-topbar");
    expect(t).not.toHaveProperty("background");
    expect(t).not.toHaveProperty("background-color");
    expect(t).not.toHaveProperty("opacity");
    expect(t).not.toHaveProperty("box-shadow");
  });

  it("phone shows the lead button and the base hides it", () => {
    expect(phone(".sf-topbar-lead").display).toBe("inline-flex");
    expect(tokens(css, ".sf-topbar-lead").display).toBe("none");
  });

  it("phone hides the project name while a lead exists", () => {
    expect(phone(".sf-shell-detail .sf-project").display).toBe("none");
  });

  it("phone hides the account name and the waiting badge but never the pause status", () => {
    expect(phone(".sf-account-name").display).toBe("none");
    expect(phone(".sf-topbar .sf-badge").display).toBe("none");
    const hidden = phoneRules(css).filter((r) => r.decls.display === "none").map((r) => r.selector);
    expect(hidden.filter((s) => /sf-paused/.test(s))).toEqual([]);
  });

  it("the in-page breadcrumb is hidden on phones", () => {
    expect(phone(".sf-breadcrumb").display).toBe("none");
  });

  it("tab bar is the nav.sf-views, fixed at the bottom and 56px", () => {
    const bar = phone(".sf-views");
    expect(bar).toMatchObject({ position: "fixed", left: "0", right: "0", bottom: "0", height: "var(--sf-tabbar-height)", background: "var(--sf-surface)" });
    expect(bar["border-top"]).toContain("var(--sf-chrome-border)");
    expect(bar["padding-bottom"]).toBe("env(safe-area-inset-bottom)");
    expect(bar["box-sizing"]).toBe("content-box");
    expect(tokens(css, ":root")["--sf-tabbar-height"]).toBe("56px");
  });

  it("tab links share the width and mark the current page", () => {
    expect(phone(".sf-view-link").flex).toBe("1");
    expect(phone('.sf-view-link[aria-current="page"]')["border-top"]).toBe("2px solid var(--sf-text)");
  });

  it("tab bar is hidden on detail screens", () => {
    expect(phone(".sf-shell-detail .sf-views").display).toBe("none");
  });

  it("main reserves room for the bars", () => {
    expect(phone(".sf-main")["padding-bottom"]).toBe("calc(var(--sf-tabbar-height) + 16px + env(safe-area-inset-bottom))");
    expect(phone(".sf-shell-detail .sf-main")["padding-bottom"]).toBe("calc(var(--sf-actionbar-button) + 16px + 16px + env(safe-area-inset-bottom))");
  });

  it("desktop values stay", () => {
    expect(tokens(css, ".sf-views").position).toBeUndefined();
    expect(tokens(css, ".sf-main")).toMatchObject({ flex: "1", padding: "32px", "min-width": "0" });
  });

  it("the phone block is the last top-level item and the only 639px block", () => {
    expect(phoneBlockInfo(css)).toEqual({ blocks: 1, itemsAfterLast: 0 });
  });

  it("phone rules add no transition or animation", () => {
    const moving = phoneRules(css).filter((r) => "transition" in r.decls || "animation" in r.decls);
    expect(moving).toEqual([]);
  });
});

describe("phone pills and lanes", () => {
  it("phone shows the pill row as a scrolling nowrap row", () => {
    expect(phone(".sf-pills")).toMatchObject({ display: "flex", "overflow-x": "auto", "flex-wrap": "nowrap" });
    expect(tokens(css, ".sf-pills").display).toBe("none");
  });

  it("pill style", () => {
    const pill = phone(".sf-pill");
    expect(pill).toMatchObject({ "min-height": "44px", flex: "0 0 auto", border: "1px solid var(--sf-border)", "border-radius": "var(--sf-radius)", background: "transparent" });
    expect(tokens(css, ":root")["--sf-radius"]).toBe("0px");
  });

  it("selected pill uses primary-soft", () => {
    expect(phone('.sf-pill[aria-pressed="true"]')).toMatchObject({ background: "var(--sf-primary-soft)", color: "var(--sf-on-primary-soft)" });
    expect(phone(".sf-pill:hover")).toMatchObject({ background: "var(--sf-primary-soft)", color: "var(--sf-on-primary-soft)" });
    expect(phoneRules(css).filter((r) => /^\.sf-pill/.test(r.selector) && /outline/.test(Object.keys(r.decls).join())).every((r) => r.decls.outline !== "none")).toBe(true);
  });

  it("the count inside a pill follows the pill's text colour", () => {
    expect(phone(".sf-pill .sf-count").color).toBe("inherit");
  });

  it("unselected lanes are hidden on phones", () => {
    expect(phone('.sf-view .sf-lane[data-selected="false"]').display).toBe("none");
  });

  it("selected lane head is hidden, its hint stays", () => {
    expect(phone(".sf-view .sf-lane .sf-lane-head").display).toBe("none");
    expect(phoneRules(css).filter((r) => /sf-lane-hint/.test(r.selector) && r.decls.display === "none")).toEqual([]);
  });

  it("empty lane text shows on phones and not at 640px and up", () => {
    expect(phone(".sf-view .sf-lane .sf-lane-empty").display).toBe("block");
    expect(tokens(css, ".sf-lane-empty").display).toBe("block");
  });

  it("desktop lanes are unchanged", () => {
    const base = css.slice(0, css.lastIndexOf("@media (max-width: 639px)"));
    expect(base).not.toContain("data-selected");
    expect((tokens(css, ".sf-lanes")["grid-template-columns"] ?? "").replace(/\s+/g, "")).toBe("minmax(0,1.2fr)repeat(3,minmax(0,1fr))");
  });

  it("the pill gets the shared colour transition and no phone rule adds one", () => {
    const list = css.match(/([^{}]+)\{\s*transition: background-color 220ms/)?.[1] ?? "";
    expect(list).toContain(".sf-pill");
  });
});

describe("phone action bar, inputs and buttons", () => {
  it("action bar is fixed with 48px buttons", () => {
    const bar = phone(".sf-action-bar");
    expect(bar).toMatchObject({ position: "fixed", left: "0", right: "0", bottom: "0", background: "var(--sf-surface)", gap: "8px", "flex-wrap": "nowrap" });
    expect(bar["border-top"]).toContain("var(--sf-chrome-border)");
    expect(bar.padding).toBe("8px 12px calc(8px + env(safe-area-inset-bottom))");
    expect(phone(".sf-action-bar .sf-button")).toMatchObject({ flex: "1", "min-height": "var(--sf-actionbar-button)" });
  });

  it("Approve and Send answer keep the accent fill and Create task the primary fill", () => {
    const bg = phoneRules(css).filter((r) => /sf-button-(accent|primary)/.test(r.selector) && ("background" in r.decls || "background-color" in r.decls));
    expect(bg).toEqual([]);
  });

  it("New task form hides Close on phones", () => {
    expect(phone(".sf-action-bar .sf-action-close").display).toBe("none");
  });

  it("inputs and selects are 44px with 16px text", () => {
    for (const s of [".sf-input", ".sf-select"]) expect(phone(s)).toMatchObject({ "min-height": "var(--sf-input-height)", "font-size": "var(--sf-input-font)" });
    expect(phone(".sf-select").height).toBe("var(--sf-input-height)");
    expect(phone("input.sf-input").height).toBe("var(--sf-input-height)");
    expect(phone("textarea.sf-input")["min-height"]).toBe("var(--sf-input-height)");
    expect(phone("textarea.sf-input").height).toBeUndefined();
  });

  it("desktop control sizes stay", () => {
    expect(tokens(css, ".sf-select").height).toBe("44px");
    expect(tokens(css, ".sf-input")["min-height"]).toBe("44px");
    expect(tokens(css, ".sf-select")["font-size"]).not.toBe("16px");
    expect(tokens(css, ".sf-input")["font-size"]).toBeUndefined();
  });

  it("task action buttons are 44px", () => {
    expect(phone(".sf-task-actions .sf-button")["min-height"]).toBe("var(--sf-input-height)");
    expect(phone(".sf-form .sf-actions:not(.sf-action-bar) .sf-button")["min-height"]).toBe("var(--sf-input-height)");
  });

  it("no phone rule sets box-shadow", () => {
    expect(phoneRules(css).filter((r) => "box-shadow" in r.decls)).toEqual([]);
  });

  it("no phone rule is out-ranked by an earlier base rule", () => {
    const ELEMENT_OF = {
      "sf-lane-name": "span", "sf-question-title": "h3", "sf-page-title": "h2", "sf-input": "input", "sf-select": "select", "sf-pill": "button", "sf-account-name": "span",
      "sf-board-view-label": "span", "sf-stepper-more": "span", "sf-task-repo": "p", "sf-question-from": "p", "sf-question-for-you": "h2",
      "sf-task-more": "details", "sf-qa-earlier": "details", "sf-chip-repo": "li"
    };
    expect(outranked(css, ELEMENT_OF, [".sf-theme-switch"])).toEqual([]);
  });
});

describe("phone rules against each other", () => {
  it("no later, more specific phone rule overrides an earlier one on the same element", () => {
    expect(phoneOutranked(css)).toEqual([]);
  });

  it("the 48px action bar button wins on the New task form", () => {
    const structure = ["form.sf-form", "div.sf-actions.sf-action-bar", "button.sf-button"];
    const winners = phoneRules(css)
      .filter((r) => r.decls["min-height"] !== undefined && matchesStructure(r.selector, structure))
      .map((r) => ({ r, spec: specificity(r.selector) }));
    expect(winners.length).toBeGreaterThan(0);
    const top = winners.reduce((a, b) => (cmpSpec(b.spec, a.spec) >= 0 ? b : a));
    expect(top.r.decls["min-height"]).toBe("var(--sf-actionbar-button)");
  });
});

function cmpSpec(a: number[], b: number[]): number {
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}

/** Whether a selector can match the element chain form.sf-form > div.sf-actions.sf-action-bar > button.sf-button. */
function matchesStructure(selector: string, chain: string[]): boolean {
  const parts = selector.split(/\s*>\s*|\s+/);
  const classesOf = (c: string) => [...c.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const nodes = chain.map((c) => ({ tag: /^[a-z]+/.exec(c)?.[0], classes: classesOf(c) }));
  let at = nodes.length - 1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as string;
    const notClasses = [...part.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]);
    const bare = part.replace(/:not\([^)]*\)/g, "");
    const tag = /^[a-z]+/.exec(bare)?.[0];
    const cls = classesOf(bare);
    let found = -1;
    for (let k = i === parts.length - 1 ? at : at - (i === parts.length - 1 ? 0 : 1); k >= 0; k--) {
      const n = nodes[k]!;
      if ((!tag || tag === n.tag) && cls.every((c) => n.classes.includes(c)) && !notClasses.some((c) => n.classes.includes(c))) {
        found = k;
        break;
      }
    }
    if (found < 0) return false;
    at = found;
  }
  return true;
}

describe("phone design gaps (T-33)", () => {
  it("base_hides_and_phone_shows_phone_only_markup", () => {
    const shown: Record<string, string> = {
      ".sf-task-repo": "block", ".sf-task-more": "block", ".sf-question-for-you": "block", ".sf-question-from": "block", ".sf-qa-earlier": "block"
    };
    for (const [s, display] of Object.entries(shown)) {
      expect(tokens(css, s).display, s).toBe("none");
      expect(phone(s).display, s).toBe(display);
    }
  });

  it("phone_hides_desktop_duplicates", () => {
    for (const s of [".sf-chip-repo", ".sf-stepper-more", ".sf-task-side .sf-details", ".sf-question-asker"]) {
      expect(phone(s).display, s).toBe("none");
    }
  });

  it("view_switch_shares_a_compact_row_with_the_filter_toggle", () => {
    expect(phone(".sf-board-view")).toMatchObject({ "flex-basis": "auto", order: "0" });
    expect(tokens(css, ".sf-board-view")).toMatchObject({ display: "inline-flex" });
  });

  it("doc_comes_first_in_the_decision_panel", () => {
    expect(phone(".sf-panel-decision")).toMatchObject({ display: "flex", "flex-direction": "column" });
    expect(phone(".sf-panel-decision > .sf-doc").order).toBe("-1");
    const base = tokens(css, ".sf-panel-decision");
    expect(base).not.toHaveProperty("order");
    expect(base).not.toHaveProperty("display");
  });

  it("decision_panel_keeps_its_spacing_as_a_flex_column", () => {
    // Flex items do not collapse margins, so the panel spaces its children with gap and zeroes their vertical margins.
    expect(phone(".sf-panel-decision").gap).toBe("12px");
    const children = phone(".sf-view .sf-panel-decision > *");
    expect(children).toMatchObject({ "margin-bottom": "0", "margin-top": "0" });
    // It must out-rank the base `.sf-view h3` margin.
    expect(cmpSpec(specificity(".sf-view .sf-panel-decision > *"), specificity(".sf-view h3"))).toBeGreaterThan(0);
  });

  it("request_changes_comes_first", () => {
    expect(phone(".sf-action-bar .sf-gate-changes").order).toBe("-1");
    const base = baseRules(css).filter((r) => r.selector.includes("sf-gate-changes") && "order" in r.decls);
    expect(base).toEqual([]);
  });

  it("phone_only_markup_rules_set_no_fill_or_motion", () => {
    const added = phoneRules(css).filter((r) => /sf-(board-view|task-repo|task-more|question-for-you|question-from|qa-earlier|gate-changes|panel-decision)/.test(r.selector));
    expect(added.length).toBeGreaterThan(0);
    for (const r of added) for (const p of ["background", "background-color", "transition", "animation", "box-shadow"]) expect(r.decls, r.selector).not.toHaveProperty(p);
  });
});

describe("narrow-phone review usability", () => {
  it("lays out six progress labels in two readable rows", () => {
    expect(phone(".sf-stepper")).toMatchObject({ display: "grid", "grid-template-columns": "repeat(3, minmax(0, 1fr))" });
  });
  it("keeps view and theme switches touch sized", () => {
    expect(phone(".sf-segment")["min-height"]).toBe("44px");
    expect(tokens(css, ".sf-theme-switch").width).toBe("44px");
  });
});


describe("settings factory picker on phones", () => {
  it("stacks the picker and limits it to the available width", () => {
    expect(phone(".sf-settings .sf-page-heading")).toMatchObject({ "flex-direction": "column", "align-items": "stretch" });
    expect(phone(".sf-settings .sf-page-heading .sf-inline-field")).toMatchObject({ "min-width": "0", width: "100%" });
    expect(phone(".sf-settings .sf-page-heading .sf-select")).toMatchObject({ "min-width": "0", width: "100%" });
  });
});

it("settings heading and factory picker do not reserve desktop flex heights on phones", () => {
  expect(phone(".sf-settings .sf-page-heading > div")["flex-basis"]).toBe("auto");
  expect(phone(".sf-settings .sf-page-heading .sf-inline-field")["flex-basis"]).toBe("auto");
});
