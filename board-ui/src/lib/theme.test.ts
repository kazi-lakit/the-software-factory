import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_KEY, resetThemeForTests, resolveInitialTheme, setTheme, useTheme } from "./theme";

const systemDark = (dark: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: dark && q.includes("dark"), media: q }));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  resetThemeForTests();
  systemDark(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveInitialTheme", () => {
  it("first_visit_system_dark_gives_dark_and_storage_stays_empty", () => {
    expect(resolveInitialTheme()).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
  it("first_visit_system_light_gives_light", () => {
    systemDark(false);
    expect(resolveInitialTheme()).toBe("light");
  });
  it("stored_light_wins_over_system_dark", () => {
    localStorage.setItem(THEME_KEY, "light");
    expect(resolveInitialTheme()).toBe("light");
  });
  it("stored_garbage_value_falls_back_to_system", () => {
    localStorage.setItem(THEME_KEY, "purple");
    systemDark(false);
    expect(resolveInitialTheme()).toBe("light");
  });
  it("matchMedia_missing_defaults_to_dark", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveInitialTheme()).toBe("dark");
  });
  it("matchMedia_throwing_defaults_to_dark", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("no");
    });
    expect(resolveInitialTheme()).toBe("dark");
  });
  it("throwing_localStorage_falls_back_to_system", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    systemDark(false);
    expect(resolveInitialTheme()).toBe("light");
  });
});

describe("setTheme", () => {
  it("sets_data_theme_and_stores_value", () => {
    setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });
  it("blocked_storage_still_applies_theme_without_throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setTheme("light")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("useTheme", () => {
  it("returns_current_theme_and_updates_on_setTheme", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe("dark");
    act(() => setTheme("light"));
    expect(result.current).toBe("light");
  });
});

describe("system_changes", () => {
  it("a_system_scheme_flip_does_not_change_a_saved_choice", () => {
    setTheme("light");
    systemDark(true);
    expect(resolveInitialTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("index_html", () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../index.html"), "utf8");
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  it("index_html_has_an_inline_script_that_sets_data_theme", () => {
    const m = head.match(/<script>([\s\S]*?)<\/script>/);
    expect(m?.[1]).toContain("factory-board:theme");
    expect(m?.[1]).toContain("data-theme");
  });
  it("inline_script_and_module_use_the_same_key", () => {
    const m = head.match(/<script>([\s\S]*?)<\/script>/);
    expect(m?.[1]).toContain(`"${THEME_KEY}"`);
  });
});
