import { useCallback, useState } from "react";

// Unsent form text per form field (ported from ACR apps/web/src/acr/unsent-text.tsx, which held unsent drawer
// text through a session end). Ids name the form: `gate:<taskId>:<gate>`, `answer:<taskId>`,
// `new-task:title`, `edit:<taskId>:title`.
//
// When the session ends, the guard unmounts the page and redirects to /login?returnTo=…, and the hosted
// sign-in then reloads the page. So the text is written to sessionStorage on every change (this tab only,
// gone when the tab closes) and restored when the form mounts again. It is cleared when the write succeeds
// and on an explicit sign out. It is text the owner typed, never a token. If sessionStorage is unavailable
// (blocked, full), the text is kept in memory instead, which survives the in-app redirect but not a reload.
const PREFIX = "factory-board:unsent:";
const memory = new Map<string, string>();

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function readUnsent(id: string): string | undefined {
  try {
    const stored = storage()?.getItem(PREFIX + id);
    if (stored !== null && stored !== undefined) return stored;
  } catch {
    // Unavailable storage: memory below.
  }
  return memory.get(id);
}

export function hasUnsent(id: string): boolean {
  return readUnsent(id) !== undefined;
}

export function keepUnsent(id: string, text: string): void {
  memory.set(id, text);
  try {
    storage()?.setItem(PREFIX + id, text);
  } catch {
    // Kept in memory only.
  }
}

export function clearUnsent(...ids: string[]): void {
  for (const id of ids) {
    memory.delete(id);
    try {
      storage()?.removeItem(PREFIX + id);
    } catch {
      // Nothing stored to remove.
    }
  }
}

/** Drops every unsent text (on sign out); other sessionStorage keys stay. */
export function clearAllUnsent(): void {
  memory.clear();
  try {
    const store = storage();
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Unavailable storage holds nothing of ours.
  }
}

/**
 * A text field's value that survives the form unmounting and a page reload. Text equal to `initial` (the
 * starting value, e.g. the task's current title) is not held. Returns the value, a setter and `clear` (after a
 * successful write).
 */
export function useUnsent(id: string, initial = ""): [string, (text: string) => void, () => void] {
  const [value, setValue] = useState(() => readUnsent(id) ?? initial);
  const set = useCallback((text: string) => {
    if (text === initial) clearUnsent(id);
    else keepUnsent(id, text);
    setValue(text);
  }, [id, initial]);
  const clear = useCallback(() => {
    clearUnsent(id);
    setValue(initial);
  }, [id, initial]);
  return [value, set, clear];
}
