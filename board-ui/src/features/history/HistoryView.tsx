import { useId, useState } from "react";
import type { FactoryEvent } from "@factory/core";
import { FactoryPicker } from "../board/FactoryPicker";
import { taskPath } from "../board/status";
import { followInApp } from "../board/TaskCard";
import { useFactories } from "../factories/useFactories";
import {
  ACTOR_FILTERS, filterEvents, NO_FILTERS, SETTINGS_TASK, useHistory, type ActorFilter, type HistoryFilters, type ModeFilter
} from "./useHistory";

type Navigate = (path: string) => void;

const PAGE = 200;
// A from or to value longer than this is cut; the full change is in the cell's title.
const MAX_VALUE = 48;

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

const valueText = (value: string | null): string => (value === null ? "—" : value.replace(/\s+/g, " ").trim());
const cut = (text: string): string => (text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text);

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

  const events = history.data?.events ?? [];
  const matching = filterEvents(events, filters);
  const shown = matching.slice(0, limit);

  return (
    <div className="sf-view">
      <div className="sf-toolbar">
        <h2 className="sf-page-title">History</h2>
      </div>
      <div className="sf-toolbar sf-filters" role="group" aria-label="Filters">
        <FactoryPicker defs={factories.defs} value={filters.factory === "" ? "all" : filters.factory} onChange={(value) => setFilter("factory", value === "all" ? "" : value)} />
        <label className="sf-inline-field" htmlFor={`${ids}-actor`}>
          <span>Actor</span>
          <select id={`${ids}-actor`} className="sf-select" value={filters.actor} onChange={(e) => setFilter("actor", e.target.value as ActorFilter)}>
            <option value="all">All actors</option>
            {ACTOR_FILTERS.map((actor) => <option key={actor} value={actor}>{actor === "you" ? "You" : actor}</option>)}
          </select>
        </label>
        <label className="sf-inline-field" htmlFor={`${ids}-mode`}>
          <span>Mode</span>
          <select id={`${ids}-mode`} className="sf-select" value={filters.mode} onChange={(e) => setFilter("mode", e.target.value as ModeFilter)}>
            <option value="all">All modes</option>
            <option value="sdk">sdk</option>
            <option value="loop">loop</option>
            <option value="session">session</option>
          </select>
        </label>
        <label className="sf-inline-field" htmlFor={`${ids}-task`}>
          <span>Task</span>
          <select id={`${ids}-task`} className="sf-select sf-mono" value={filters.task} onChange={(e) => setFilter("task", e.target.value)}>
            <option value="">All tasks</option>
            <option value={SETTINGS_TASK}>Settings and factories</option>
            {(history.data?.taskIds ?? []).map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="sf-inline-field" htmlFor={`${ids}-from`}>
          <span>From</span>
          <input id={`${ids}-from`} type="date" className="sf-input" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
        </label>
        <label className="sf-inline-field" htmlFor={`${ids}-to`}>
          <span>To</span>
          <input id={`${ids}-to`} type="date" className="sf-input" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
        </label>
        <label className="sf-inline-field">
          <input type="checkbox" checked={showTest} onChange={(e) => toggleTest(e.target.checked)} />
          <span>Show test tasks</span>
        </label>
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
          <p className="sf-empty">No events match these filters.</p>
        ) : (
          <>
            <div className="sf-table-wrap">
              <table className="sf-table sf-history-table" aria-label="History">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Task</th>
                    <th scope="col">Field</th>
                    <th scope="col">Change</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((event, index) => (
                    <EventRow key={`${event.taskId}:${event.at}:${index}`} event={event} onNavigate={onNavigate} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sf-actions sf-paging">
              <span className="sf-muted">Showing {shown.length} of {matching.length}.</span>
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

function EventRow({ event, onNavigate }: { event: FactoryEvent; onNavigate: Navigate }) {
  const from = valueText(event.from);
  const to = valueText(event.to);
  const full = `${from} → ${to}`;
  const shown = `${cut(from)} → ${cut(to)}`;
  const href = taskPath(event.taskId);
  return (
    <tr>
      <td className="sf-nowrap"><time dateTime={event.at}>{formatTime(event.at)}</time></td>
      <td>{event.actor}</td>
      <td>
        {event.taskId === SETTINGS_TASK ? (
          /^(def|repo)\./.test(event.field ?? "") ? "Factory" : "Settings"
        ) : (
          <a className="sf-mono" href={href} onClick={(e) => followInApp(e, href, onNavigate)}>{event.taskId}</a>
        )}
      </td>
      <td className="sf-mono">{event.field ?? event.action}</td>
      <td className="sf-mono" title={shown === full ? undefined : full}>{shown}</td>
      <td>{event.reason}</td>
    </tr>
  );
}
