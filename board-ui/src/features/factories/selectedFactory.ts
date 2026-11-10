import { useCallback, useEffect, useState } from "react";

export const SELECTED_FACTORY_KEY = "factory-board:factory";

// The pick is read from localStorage once per page and kept here, so a view mounted later agrees with the shell. A pick made
// here reaches every mounted view through the listeners. A pick made in another tab is not followed while the page is open
// (it would remount keyed Settings forms and drop their drafts); it is read on the next load. Without a writable
// localStorage the pick still applies for the life of the page.
const listeners = new Set<(value: string) => void>();
let current: string | undefined;

const read = (): string => {
  if (current === undefined) {
    try {
      current = window.localStorage.getItem(SELECTED_FACTORY_KEY) || "all";
    } catch {
      current = "all";
    }
  }
  return current;
};

/** Test only: forget the page's pick so the next read starts from localStorage again. */
export function resetSelectedFactoryForTests(): void {
  current = undefined;
}

/** The factory picked on the Board (`'all'` for every factory), kept in localStorage; works without it. */
export function useSelectedFactory(): [string | "all", (value: string | "all") => void] {
  const [selected, setSelected] = useState(read);
  useEffect(() => {
    listeners.add(setSelected);
    return () => void listeners.delete(setSelected);
  }, []);
  const set = useCallback((value: string | "all") => {
    current = value;
    try {
      window.localStorage.setItem(SELECTED_FACTORY_KEY, value);
    } catch {
      // Not kept for the next visit; the pick applies until the page closes.
    }
    for (const listener of listeners) listener(value);
  }, []);
  return [selected, set];
}
