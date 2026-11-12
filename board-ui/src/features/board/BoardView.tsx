import { Plus, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useState } from "react";
import { unfinishedDeps, type FactoryRepo, type Status, type Task } from "@factory/core";
import { useFactories, useSelectedFactory } from "../factories/useFactories";
import { FactoryPicker } from "./FactoryPicker";
import { byAge, laneOf, LANES, type LaneId } from "./lanes";
import { COLUMNS, isTestTask, MUTED, NEEDS_YOU, STATUS_LABEL } from "./status";
import { followInApp, TaskCard } from "./TaskCard";
import { useBoard } from "./useBoard";
import { useBoardView } from "./useBoardView";

type Navigate = (path: string) => void;

const NO_REPOS: readonly FactoryRepo[] = [];
const NEW_TASK_PATH = "/tasks/new";
const SUMMARY_COPY: Partial<Record<LaneId, string>> = {
  "needs-you": "Awaiting your decision",
  queued: "Ready for the next step",
  working: "Moving through the factory",
  done: "Completed and merged"
};

const repoKey = (repo: FactoryRepo) => `${repo.factoryId}/${repo.repoId}`;

/**
 * The queue: lanes or a column per status, factory and repo filters, test tasks hidden by default, and a link to the
 * New task page. A New task link (`/?new=1&…`, made by /factory:new) is forwarded to `/tasks/new` with its parameters.
 */
export function BoardView({ onNavigate }: { onNavigate: Navigate }) {
  const board = useBoard();
  const factories = useFactories();
  const filterId = useId();
  const listIdBase = useId();
  const [picked, setPicked] = useSelectedFactory();
  const [repo, setRepo] = useState("");
  const [view, setView] = useBoardView();
  const [showTest, setShowTest] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // In memory only: a reload starts with an empty search.
  const [query, setQuery] = useState("");
  // The Stopped lane starts collapsed; in memory only.
  const [stoppedOpen, setStoppedOpen] = useState(false);
  // Phones show one lane at a time. In memory only: a reload selects Needs you again.
  const [selectedLane, setSelectedLane] = useState<LaneId>("needs-you");
  const [expanded, setExpanded] = useState<ReadonlySet<Status>>(new Set());
  // Expansion is not remembered: leaving All stages collapses Done and Cancelled again.
  useEffect(() => {
    if (view !== "stages") setExpanded((current) => (current.size === 0 ? current : new Set()));
  }, [view]);
  // A New task link opens the New task page with the same parameters; replaced, so Back does not loop.
  useLayoutEffect(() => {
    const { hash, search } = window.location;
    if (new URLSearchParams(search).get("new") !== "1") return;
    window.history.replaceState(window.history.state, "", `${NEW_TASK_PATH}${search}${hash}`);
    // replaceState fires no event: tell the router.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // A pick that is no longer a visible factory counts as All; tasks of a factory that is not visible show under All.
  const known = factories.byId.has(picked);
  const factory = picked === "all" || (!factories.loading && !known) ? "all" : picked;
  const all = factory === "all";
  const repoOptions: readonly FactoryRepo[] = all ? factories.repos : (factories.byId.get(factory)?.repos ?? NO_REPOS);

  const inFactory = (board.data ?? []).filter((task) => all || task.factoryId === factory);
  // The search matches a task's id or title, case-insensitive; it applies before the split, so both views follow it.
  const q = query.trim().toLowerCase();
  const matches = (task: Task) => q === "" || task.taskId.toLowerCase().includes(q) || task.title.toLowerCase().includes(q);
  const visible = inFactory.filter((task) => (showTest || !isTestTask(task)) && (repo === "" || (all ? `${task.factoryId}/${task.repo}` : task.repo) === repo) && matches(task));
  const allTasks = board.data ?? [];
  const waitingOn = (task: Task): string[] => (task.status === "ready" ? unfinishedDeps(task, allTasks) : []);
  const byStatus = new Map<Status, Task[]>(COLUMNS.map((status) => [status, []]));
  for (const task of visible) byStatus.get(task.status)?.push(task);
  // Lanes keep today's per-status order inside a lane; a status outside COLUMNS (runtime safety net) lands in Working.
  const byLane = new Map<LaneId, Task[]>(LANES.map((lane) => [lane.id, []]));
  for (const status of COLUMNS) byLane.get(laneOf(status))?.push(...(byStatus.get(status) ?? []));
  for (const task of visible) if (!byStatus.has(task.status)) byLane.get(laneOf(task.status))?.push(task);
  // Needs you is oldest first across its statuses: the longest wait comes first.
  byLane.get("needs-you")?.sort(byAge);

  function toggle(status: Status) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className={view === "stages" ? "sf-view sf-board-page sf-view-stages" : "sf-view sf-board-page"}>
      <header className="sf-page-heading">
        <div><h1 className="sf-page-title">Board</h1></div>
        <a href={NEW_TASK_PATH} className="sf-button sf-button-primary" onClick={(event) => followInApp(event, NEW_TASK_PATH, onNavigate)}><Plus size={16} aria-hidden="true" />New task</a>
      </header>
      <div className="sf-queue-summary" role="group" aria-label="Queue summary">
        {LANES.filter((lane) => lane.id !== "stopped").map((lane) => (
          <div key={lane.id} className={`sf-queue-stat sf-queue-stat-${lane.id}`}>
            <span>{lane.name}</span>
            <strong>{!board.data ? "—" : byLane.get(lane.id)?.length ?? 0}</strong>
            <span className="sf-queue-stat-caption">{SUMMARY_COPY[lane.id]}</span>
          </div>
        ))}
      </div>
      <div className="sf-board-controls">
        <div className="sf-toolbar sf-board-filters">
        <div id={`${filterId}-options`} className="sf-board-filter-fields" data-open={filtersOpen}>
        <FactoryPicker
          defs={factories.defs}
          value={factory}
          onChange={(value) => {
            setPicked(value);
            setRepo("");
          }}
        />
        <label className="sf-inline-field" htmlFor={filterId}>
          <span>Repo</span>
          <select id={filterId} className="sf-select" value={repo} onChange={(event) => setRepo(event.target.value)}>
            <option value="">All repos</option>
            {repoOptions.map((r) => {
              const value = all ? repoKey(r) : r.repoId;
              return <option key={value} value={value}>{value}</option>;
            })}
          </select>
        </label>
        {filtersOpen ? <label className="sf-inline-field">
          <input type="checkbox" checked={showTest} onChange={(event) => setShowTest(event.target.checked)} />
          <span>Show test tasks</span>
        </label> : null}
        </div>
        <input
          type="search"
          className="sf-input sf-board-search"
          aria-label="Search tasks by title or id"
          placeholder="Search tasks by title or id"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="sf-board-view">
          <span className="sf-label sf-board-view-label">View</span>
          <div role="group" aria-label="Board view" className="sf-segmented">
            <button type="button" className="sf-segment" aria-pressed={view === "lanes"} onClick={() => setView("lanes")}>Lanes</button>
            <button type="button" className="sf-segment" aria-pressed={view === "stages"} onClick={() => setView("stages")}>All stages</button>
          </div>
        </div>
        <button type="button" className="sf-button sf-filter-toggle" aria-expanded={filtersOpen} aria-controls={`${filterId}-options`} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal size={14} aria-hidden="true" />Filters{repo || showTest || factory !== "all" ? " (active)" : ""}</button>
        </div>
        <div className="sf-board-results"><span>{board.isPending ? "Loading your workspace…" : `${visible.length} ${visible.length === 1 ? "task" : "tasks"} in view`}</span>{query || repo || showTest || factory !== "all" ? <button type="button" className="sf-button" onClick={() => { setQuery(""); setRepo(""); setShowTest(false); setPicked("all"); }}>Reset filters</button> : null}</div>
      </div>
      {board.data && visible.length === 0 && (query || repo) ? (
        <div className="sf-filter-empty">
          <Search size={24} aria-hidden="true" />
          <h2>No tasks match your filters.</h2>
          <p>Try another title, task id, or repository.</p>
          <button type="button" className="sf-button" onClick={() => { setQuery(""); setRepo(""); }}>Clear filters</button>
        </div>
      ) : null}

      {board.isError ? (
        <div className="sf-problem" role="alert">
          <span>{board.data ? "Could not refresh the Board; showing what was loaded last." : "Could not load the Board."}</span>
          <button type="button" className="sf-button" onClick={() => void board.refetch()}>Try again</button>
        </div>
      ) : null}
      {board.isPending ? <p className="sf-empty" role="status">Loading tasks…</p> : null}

      {board.data && view === "lanes" ? (
        <>
        <div role="group" aria-label="Lane" className="sf-pills">
          {LANES.map((lane) => (
            <button
              key={lane.id}
              type="button"
              className="sf-pill"
              aria-pressed={selectedLane === lane.id}
              onClick={() => {
                setSelectedLane(lane.id);
                // Phones hide the lane head, so picking Stopped opens it: the cancelled cards stay reachable.
                if (lane.id === "stopped") setStoppedOpen(true);
              }}
            >
              {lane.name} <span className="sf-count sf-mono">{byLane.get(lane.id)?.length ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="sf-lanes">
          {LANES.map((lane) => {
            const tasks = byLane.get(lane.id) ?? [];
            const stopped = lane.id === "stopped";
            // Done shows the two most recent (highest id); Stopped lists its cards only while open.
            const shown = lane.id === "done" ? [...tasks].sort((a, b) => byAge(b, a)).slice(0, 2) : stopped && !stoppedOpen ? [] : tasks;
            const listId = stopped ? `${listIdBase}-lane-stopped` : undefined;
            const tone = lane.id === "needs-you" ? " sf-lane-needs-you" : stopped ? " sf-lane-stopped" : "";
            return (
              <section
                key={lane.id}
                className={`sf-lane${tone}`}
                aria-label={lane.name}
                data-selected={selectedLane === lane.id ? "true" : "false"}
              >
                <div className="sf-lane-head">
                  <span className="sf-label sf-lane-name">{lane.name}</span>
                  <span className="sf-count sf-mono">{tasks.length}</span>
                  {stopped ? (
                    <button
                      type="button"
                      className="sf-show-toggle"
                      aria-expanded={stoppedOpen}
                      aria-controls={shown.length > 0 ? listId : undefined}
                      onClick={() => setStoppedOpen(!stoppedOpen)}
                    >
                      {stoppedOpen ? "Hide" : "Show"}
                    </button>
                  ) : null}
                </div>
                {lane.hint ? <p className="sf-lane-hint">{lane.hint}</p> : null}
                {shown.length > 0 ? (
                  <ul id={listId} className="sf-card-list">
                    {shown.map((task) => (
                      <li key={task.taskId}><TaskCard task={task} showFactory={all} view="lanes" waitingOn={waitingOn(task)} onNavigate={onNavigate} /></li>
                    ))}
                  </ul>
                ) : tasks.length === 0 ? (
                  <p className={`sf-empty sf-lane-empty${selectedLane === lane.id ? " sf-lane-empty-selected" : ""}`}>Nothing in {lane.name}.</p>
                ) : null}
                {lane.id === "done" && tasks.length > 0 ? (
                  <a className="sf-lane-more" href="/history" onClick={(event) => followInApp(event, "/history", onNavigate)}>
                    Show all {tasks.length} in History
                  </a>
                ) : null}
              </section>
            );
          })}
        </div>
        </>
      ) : null}

      {board.data && view === "stages" ? (
        <>
        <p className="sf-columns-hint">
          <span>Every status as its own column. Outlined columns wait for you.</span>
          <span>Scroll sideways for Review, PR open, Done, Blocked and Cancelled</span>
        </p>
        <div className="sf-columns">
          {COLUMNS.map((status) => {
            const tasks = byStatus.get(status) ?? [];
            const collapsible = MUTED.has(status);
            const open = !collapsible || expanded.has(status);
            const listed = open && tasks.length > 0;
            const listId = `${listIdBase}-${status}`;
            const tone = collapsible ? " sf-column-muted" : "";
            return (
              <section key={status} className={`sf-column${tone}${NEEDS_YOU.has(status) ? " sf-column-needs-you" : ""}${open ? "" : " sf-column-collapsed"}`} aria-label={STATUS_LABEL[status]}>
                <h3 className="sf-column-head">
                  <span className="sf-label sf-lane-name">{STATUS_LABEL[status]}</span>
                  <span className="sf-count sf-mono">{tasks.length}</span>
                  {collapsible ? (
                    <button type="button" className="sf-show-toggle" aria-expanded={open} aria-controls={listed ? listId : undefined} onClick={() => toggle(status)}>
                      {open ? "Hide" : "Show"}
                    </button>
                  ) : null}
                </h3>
                {open && tasks.length === 0 ? (
                  <p className="sf-empty sf-column-empty">{NEEDS_YOU.has(status) ? "Nothing waiting" : "Nothing here"}</p>
                ) : null}
                {listed ? (
                  <ul id={listId} className="sf-card-list">
                    {tasks.map((task) => (
                      <li key={task.taskId}><TaskCard task={task} showFactory={all} view="stages" waitingOn={waitingOn(task)} onNavigate={onNavigate} /></li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
        </>
      ) : null}
    </div>
  );
}

