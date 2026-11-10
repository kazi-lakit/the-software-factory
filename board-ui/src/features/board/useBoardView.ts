import { useCallback, useEffect, useState } from "react";

export const BOARD_VIEW_KEY = "factory-board:view";
export type BoardViewMode = "lanes" | "stages";

// Read from localStorage once per page and shared by every mounted view; works without a writable localStorage.
const listeners = new Set<(value: BoardViewMode) => void>();
let current: BoardViewMode | undefined;

const read = (): BoardViewMode => {
  if (current === undefined) {
    try {
      current = window.localStorage.getItem(BOARD_VIEW_KEY) === "stages" ? "stages" : "lanes";
    } catch {
      current = "lanes";
    }
  }
  return current;
};

/** Test only: forget the page's choice so the next read starts from localStorage again. */
export function resetBoardViewForTests(): void {
  current = undefined;
}

/** The Board view (Lanes by default, or All stages), kept in localStorage. */
export function useBoardView(): [BoardViewMode, (value: BoardViewMode) => void] {
  const [view, setView] = useState(read);
  useEffect(() => {
    listeners.add(setView);
    return () => void listeners.delete(setView);
  }, []);
  const set = useCallback((value: BoardViewMode) => {
    current = value;
    try {
      window.localStorage.setItem(BOARD_VIEW_KEY, value);
    } catch {
      // Not kept for the next visit; the choice applies until the page closes.
    }
    for (const listener of listeners) listener(value);
  }, []);
  return [view, set];
}
