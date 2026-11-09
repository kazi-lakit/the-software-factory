import { useCallback, useState } from "react";

// Unsent form text, kept in memory per form field (ported from ACR apps/web/src/acr/unsent-text.tsx, which
// held unsent drawer text through a session end). Ids name the form: `gate:<taskId>:<gate>`,
// `answer:<taskId>`, `new-task:title`, `edit:<taskId>:title`. When the session ends the guard unmounts the
// page and redirects to /login?returnTo=…; the text stays here, and the form restores it when it mounts
// again. It is cleared only when the write succeeds (or on an explicit sign out). Memory only: nothing is
// written to browser storage, so a full page load (the hosted sign-in redirect) does not keep it.
const texts = new Map<string, string>();

export function readUnsent(id: string): string | undefined {
  return texts.get(id);
}

export function hasUnsent(id: string): boolean {
  return texts.has(id);
}

export function keepUnsent(id: string, text: string): void {
  texts.set(id, text);
}

export function clearUnsent(...ids: string[]): void {
  for (const id of ids) texts.delete(id);
}

export function clearAllUnsent(): void {
  texts.clear();
}

/**
 * A text field's value that survives the form unmounting. Text equal to `initial` (the starting value, e.g. the
 * task's current title) is not held. Returns the value, a setter and `clear` (after a successful write).
 */
export function useUnsent(id: string, initial = ""): [string, (text: string) => void, () => void] {
  const [value, setValue] = useState(() => texts.get(id) ?? initial);
  const set = useCallback((text: string) => {
    if (text === initial) texts.delete(id);
    else texts.set(id, text);
    setValue(text);
  }, [id, initial]);
  const clear = useCallback(() => {
    texts.delete(id);
    setValue(initial);
  }, [id, initial]);
  return [value, set, clear];
}
