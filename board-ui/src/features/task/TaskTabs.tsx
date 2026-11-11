import { useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export type TaskTab = { id: string; label: string; content: ReactNode };

/**
 * A tab strip with one panel: the first tab is selected at first. Arrow keys move between tabs with wrap,
 * Home and End go to the ends; only the selected tab is in the Tab order.
 */
export function TaskTabs({ label, tabs }: { label: string; tabs: readonly TaskTab[] }) {
  const baseId = useId();
  const [selected, setSelected] = useState(tabs[0]?.id);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === selected));
  const current = tabs[index];
  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = `${baseId}-panel`;

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
            aria-controls={panelId}
            tabIndex={i === index ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(index)} className="sf-tab-panel" tabIndex={0}>
        {current?.content}
      </div>
    </section>
  );
}
