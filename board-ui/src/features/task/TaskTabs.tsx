import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export type TaskTab = { id: string; label: string; content: ReactNode; keepMounted?: boolean };

/**
 * A tab strip with one panel: the first tab is selected at first. Arrow keys move between tabs with wrap,
 * Home and End go to the ends; only the selected tab is in the Tab order.
 */
export function TaskTabs({ label, tabs, value, onChange }: { label: string; tabs: readonly TaskTab[]; value?: string; onChange?: (id: string) => void }) {
  const baseId = useId();
  const [internal, setInternal] = useState(tabs[0]?.id);
  const selected = value ?? internal;
  const visited = useRef(new Set<string>());
  if (selected) visited.current.add(selected);
  const setSelected = (id: string) => { setInternal(id); onChange?.(id); };
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const previousValue = useRef(value);
  useEffect(() => {
    if (value !== previousValue.current) {
      const next = tabs.findIndex((tab) => tab.id === value);
      if (next >= 0) refs.current[next]?.focus();
      previousValue.current = value;
    }
  }, [value, tabs]);
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === selected));
  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = (i: number) => `${baseId}-panel-${i}`;

  const move = (to: number) => {
    const next = (to + tabs.length) % tabs.length;
    setSelected(tabs[next]!.id);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const target =
      event.key === "ArrowRight" ? index + 1 :
      event.key === "ArrowLeft" ? index - 1 :
      event.key === "Home" ? 0 :
      event.key === "End" ? tabs.length - 1 : undefined;
    if (target === undefined) return;
    event.preventDefault();
    move(target);
  };

  return (
    <section className="sf-task-tabs">
      <div className="sf-tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            className="sf-tab"
            id={tabId(i)}
            aria-selected={i === index}
            aria-controls={panelId(i)}
            tabIndex={i === index ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div key={tab.id} role="tabpanel" id={panelId(i)} aria-labelledby={tabId(i)} className="sf-tab-panel" tabIndex={0} hidden={i !== index}>
          {i === index || (tab.keepMounted && visited.current.has(tab.id)) ? tab.content : null}
        </div>
      ))}
    </section>
  );
}
