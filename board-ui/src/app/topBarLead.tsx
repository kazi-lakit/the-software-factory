import { createContext, useContext, useEffect, useRef } from "react";

export type Lead = { label: string; onClick: () => void };

// AppShell provides the setter; a screen registers a lead (Back, Cancel) while it is mounted. Without
// a provider (a view rendered alone in a test) the hook does nothing.
export const TopBarLeadContext = createContext<((lead: Lead | null) => void) | undefined>(undefined);

export function useTopBarLead(lead: Lead | null): void {
  const set = useContext(TopBarLeadContext);
  const click = useRef<(() => void) | undefined>(undefined);
  click.current = lead?.onClick;
  const label = lead?.label ?? null;
  useEffect(() => {
    if (!set || label === null) return;
    set({ label, onClick: () => click.current?.() });
    return () => set(null);
  }, [set, label]);
}
