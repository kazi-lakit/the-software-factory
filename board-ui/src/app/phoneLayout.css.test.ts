import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { phoneBlockInfo, phoneRules } from "../test/cssMedia";
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
    expect(root["--sf-bar-height"]).toBe("52px");
  });
});

describe("phone top bar and tab bar", () => {
  it("phone top bar is compact", () => {
    expect(phone(".sf-topbar")["min-height"]).toBe("48px");
    expect(phone(".sf-topbar").padding).toBe("0 12px");
    expect(tokens(css, ".sf-topbar")["min-height"]).toBe("var(--sf-bar-height)");
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
    expect(tokens(css, ".sf-main")).toEqual({ flex: "1", padding: "16px" });
  });

  it("the phone block is the last top-level item and the only 639px block", () => {
    expect(phoneBlockInfo(css)).toEqual({ blocks: 1, itemsAfterLast: 0 });
  });

  it("phone rules add no transition or animation", () => {
    const moving = phoneRules(css).filter((r) => "transition" in r.decls || "animation" in r.decls);
    expect(moving).toEqual([]);
  });
});
