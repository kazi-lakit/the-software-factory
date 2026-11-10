import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

export const THEME_KEY = "factory-board:theme";

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

/** The saved choice, else the system setting, else dark. Never throws. */
export function resolveInitialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Storage blocked: fall through to the system setting.
  }
  try {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {
    // Fall through to dark.
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

// Module state so every mounted switch agrees. The system setting is only read at start-up (a saved choice must not move).
const listeners = new Set<() => void>();
let current: Theme | undefined;

const read = (): Theme => {
  if (current === undefined) {
    const attr = document.documentElement.getAttribute("data-theme");
    current = isTheme(attr) ? attr : resolveInitialTheme();
  }
  return current;
};

/** Test only: forget the page's theme so the next read starts again. */
export function resetThemeForTests(): void {
  current = undefined;
}

/** Apply the theme and remember it; without writable storage it still applies for the life of the page. */
export function setTheme(theme: Theme): void {
  current = theme;
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not kept for the next visit.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, read);
}
