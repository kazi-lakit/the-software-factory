import { useId, useMemo, useState } from "react";
import type { FactoryEvent } from "@factory/core";
import { FactoryPicker } from "../board/FactoryPicker";
import { taskPath } from "../board/status";
import { followInApp } from "../board/TaskCard";
import { useFactories } from "../factories/useFactories";
import {
  ACTOR_FILTERS, filterEvents, NO_FILTERS, SETTINGS_TASK, useHistory,
  type ActorFilter, type HistoryFilters, type PillFilter, type WhenFilter
} from "./useHistory";
import { describeEvent, eventContexts, type Description } from "../../lib/describeEvent";
import { formatTime, formatWhen } from "../../lib/formatTime";

type Navigate = (path: string) => void;

const PAGE = 200;
const WHO_LABEL: Readonly<Record<ActorFilter, string>> = {
  all: "Everyone",
  core: "Core",
  implementer: "Implementer",
  planner: "Planner",
  reviewer: "Reviewer",
  "spec-writer": "Spec writer",
  verifier: "Verifier",
  you: "You"
};

const WHEN_OPTIONS: readonly (readonly [WhenFilter, string])[] = [["7d", "Last 7 days"], ["today", "Today"], ["30d", "Last 30 days"], ["all", "All time"]];

const PILLS: readonly (readonly [PillFilter, string])[] = [
  ["all", "All changes"], ["you", "Your decisions"], ["qa", "Questions and answers"], ["moves", "Status moves"], ["settings", "Settings"]
];

/** Every change the factory and the owner made, newest first, with filters. */
export function HistoryView({ onNavigate }: { onNavigate: Navigate }) {
  const ids = useId();
  const [showTest, setShowTest] = useState(false);
  const [filters, setFilters] = useState<HistoryFilters>(NO_FILTERS);
  const [limit, setLimit] = useState(PAGE);
  const history = useHistory(showTest);
  const factories = useFactories();

  function setFilter<K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setLimit(PAGE);
  }

  function toggleTest(on: boolean) {
    setShowTest(on);
    // A hidden test task can no longer be picked.
    if (!on && filters.task.startsWith("GATE-")) setFilter("task", "");
  }

  const events = useMemo(() => history.data?.events ?? [], [history.data]);
  const described = useMemo(() => {
    const contexts = eventContexts(events);
    return new Map<FactoryEvent, Description>(events.map((event) => [event, describeEvent(event, contexts.get(event))]));
  }, [events]);
  const now = new Date();
  const matching = filterEvents(events, filters, { changeText: (event) => described.get(event)!.text, now, titles: history.data?.titles });
  const shown = matching.slice(0, limit);

  return (
    <div className="sf-view">
      <header className="sf-page-heading"><div><p className="sf-eyebrow">Workspace activity</p><h1 className="sf-page-title">History</h1><p className="sf-page-description">Every decision, change, and step forward. All in one place.</p></div></header>
      <div className="sf-toolbar sf-filters" role="group" aria-label="Filters">
        <input
          type="search"
          className="sf-input"
          aria-label="Search history"
          placeholder="Search history"
          value={filters.search}
          onChange={(e) => setFilter("search", e.target.value)}
        />
        <label className="sf-inline-field" htmlFor={`${ids}-who`}>
          <span>Who</span>
          <select id={`${ids}-who`} className="sf-select" value={filters.actor} onChange={(e) => setFilter("actor", e.target.value as ActorFilter)}>
            {(["all", ...ACTOR_FILTERS] as const).map((actor) => <option key={actor} value={actor}>{WHO_LABEL[actor]}</option>)}
          </select>
        </label>
        <label className="sf-inline-field" htmlFor={`${ids}-task`}>
          <span>Task</span>
          <select id={`${ids}-task`} className="sf-select sf-mono" value={filters.task} onChange={(e) => setFilter("task", e.target.value)}>
            <option value="">All tasks</option>
            {(history.data?.taskIds ?? []).map((id) => <option key={id} value={id}>{id}</option>)}
            <option value={SETTINGS_TASK}>Settings</option>
          </select>
        </label>
        <label className="sf-inline-field" htmlFor={`${ids}-when`}>
          <span>When</span>
          <select id={`${ids}-when`} className="sf-select" value={filters.when} onChange={(e) => setFilter("when", e.target.value as WhenFilter)}>
            {WHEN_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {factories.defs.length > 1 ? (
          <FactoryPicker defs={factories.defs} value={filters.factory === "" ? "all" : filters.factory} onChange={(value) => setFilter("factory", value === "all" ? "" : value)} />
        ) : null}
        {history.data?.hasTestTasks ? (
          <label className="sf-inline-field">
            <input type="checkbox" checked={showTest} onChange={(e) => toggleTest(e.target.checked)} />
            <span>Show test tasks</span>
          </label>
        ) : null}
      </div>
      <div className="sf-history-pills" role="group" aria-label="Change type">
        {PILLS.map(([value, label]) => (
          <button key={value} type="button" className="sf-history-pill" aria-pressed={filters.pill === value} onClick={() => setFilter("pill", value)}>
            {label}
          </button>
        ))}
      </div>

      {history.isError ? (
        <div className="sf-problem" role="alert">
          <span>{history.data ? "Could not refresh the history; showing what was loaded last." : "Could not load the history."}</span>
          <button type="button" className="sf-button" onClick={() => void history.refetch()}>Try again</button>
        </div>
      ) : null}
      {history.isPending ? <p className="sf-empty" role="status">Loading history…</p> : null}

      {history.data ? (
        events.length === 0 ? (
          <p className="sf-empty">No history yet.</p>
        ) : matching.length === 0 ? (
          <div className="sf-filter-empty"><h2>No events match these filters.</h2><p>Choose a wider date range or clear your filters.</p><button className="sf-button" type="button" onClick={() => { setFilters(NO_FILTERS); setLimit(PAGE); }}>Clear filters</button></div>
        ) : (
          <>
            <div className="sf-table-wrap">
              <table className="sf-table sf-history-table" aria-label="History">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">Task</th>
                    <th scope="col">Change</th>
                    <th scope="col">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((event, index) => (
                    <EventRow key={`${event.taskId}:${event.at}:${index}`} event={event} description={described.get(event)!} now={now} onNavigate={onNavigate} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sf-actions sf-paging">
              <span className="sf-muted">Showing {shown.length} of {matching.length} changes</span>
              {shown.length < matching.length ? (
                <button type="button" className="sf-button" onClick={() => setLimit((n) => n + PAGE)}>Show more</button>
              ) : null}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

function EventRow({ event, description, now, onNavigate }: { event: FactoryEvent; description: Description; now: Date; onNavigate: Navigate }) {
  const [first = "", mode] = event.actor.split(" · ");
  const role = first.replace(/-/g, " ");
  const href = taskPath(event.taskId);
  return (
    <tr>
      <td className="sf-nowrap"><time dateTime={event.at} title={formatTime(event.at)}>{formatWhen(event.at, now)}</time></td>
      <td>{role}{mode ? <span className="sf-muted"> · {mode}</span> : null}</td>
      <td>
        {event.taskId === SETTINGS_TASK ? (
          /^(def|repo)\./.test(event.field ?? "") ? "Factory" : "Settings"
        ) : (
          <a className="sf-mono" href={href} onClick={(e) => followInApp(e, href, onNavigate)}>{event.taskId}</a>
        )}
      </td>
      <td className="sf-history-change" title={description.text}>
        {description.parts.map((part, i) =>
          typeof part === "string" ? part : <span key={i} className="sf-chip">{part.label}</span>
        )}
      </td>
      <td className="sf-muted">{event.reason}</td>
    </tr>
  );
}
