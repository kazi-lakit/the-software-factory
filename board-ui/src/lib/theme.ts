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

// The DOM attribute is the single source of truth, so it is read on every snapshot and the hook follows any change to it.
const read = (): Theme => {
  const attr = document.documentElement.getAttribute("data-theme");
  return isTheme(attr) ? attr : resolveInitialTheme();
};

/** Apply the theme and remember it; without writable storage it still applies for the life of the page. */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not kept for the next visit.
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One failing listener must not stop the others.
    }
  }
}

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    listeners.delete(listener);
    observer.disconnect();
  };
};

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, read);
}
