import { useQuery } from "@tanstack/react-query";
import type { FactoryEvent, Mode } from "@factory/core";
import { boardStore } from "../../lib/board";
import { isTestTask } from "../board/status";
import { isQaEvent } from "../../lib/qaEvent";

/** Every history query starts with this key; a settings save invalidates them all. */
export const HISTORY_KEY = ["history"] as const;

/** The task id settings events are stored under. */
export const SETTINGS_TASK = "-";

export type HistoryData = {
  /** Every event of the listed tasks and the settings, newest first. */
  events: FactoryEvent[];
  /** The tasks whose events were read, for the task filter. */
  taskIds: string[];
};

// Reads at most this many task histories at once.
const PARALLEL_READS = 6;

/**
 * The factory's history: each task's events (`listEvents(taskId)`) plus the settings events (`listEvents('-')`),
 * merged newest first. Never one unfiltered `listEvents()`: the list endpoint caps its pages, so a whole-table
 * read would silently drop events. GATE-* test tasks are read only when `showTest` is on.
 */
export function useHistory(showTest: boolean) {
  return useQuery({
    // Ticking "Show test tasks" keeps the current rows on screen while the wider read loads.
    placeholderData: (previous) => previous,
    queryFn: () => loadHistory(showTest),
    queryKey: [...HISTORY_KEY, { showTest }],
    refetchInterval: 60_000
  });
}

async function loadHistory(showTest: boolean): Promise<HistoryData> {
  const tasks = (await boardStore.listTasks()).filter((task) => showTest || !isTestTask(task));
  const taskIds = tasks.map((task) => task.taskId).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const lists = await mapLimit([...taskIds, SETTINGS_TASK], PARALLEL_READS, (taskId) => boardStore.listEvents(taskId));
  return { events: newestFirst(lists), taskIds };
}

/**
 * Each list is oldest first (as listEvents gives it). The merge is newest first; events with the same time keep
 * their reverse stored order within a task.
 */
export function newestFirst(lists: readonly (readonly FactoryEvent[])[]): FactoryEvent[] {
  const tagged = lists.flatMap((list, l) => list.map((event, i) => ({ event, i, l })));
  tagged.sort((a, b) => compareAt(b.event.at, a.event.at) || a.l - b.l || b.i - a.i);
  return tagged.map((t) => t.event);
}

function compareAt(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0;
  return x - y;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Actor text: "you", "core · <mode>", or "<agent> · <mode> · run <runId>".
const MODES: readonly Mode[] = ["sdk", "loop", "session"];

export const ACTOR_FILTERS = ["you", "spec-writer", "planner", "implementer", "verifier", "reviewer", "core"] as const;
export type ActorFilter = (typeof ACTOR_FILTERS)[number] | "all";
export type ModeFilter = Mode | "all";

export function actorMatches(actor: string, filter: ActorFilter): boolean {
  if (filter === "all") return true;
  if (filter === "core") return actor.startsWith("core");
  return actor.split(" · ")[0] === filter;
}

/** The mode in an agent or core actor; the owner's events have none. */
export function actorMode(actor: string): Mode | undefined {
  const mode = actor.split(" · ")[1];
  return MODES.find((m) => m === mode);
}

/** The event's local calendar date as YYYY-MM-DD, the format of a date input. */
export function localDate(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type KindFilter = "all" | "qa";

export type HistoryFilters = { actor: ActorFilter; factory: string; kind: KindFilter; mode: ModeFilter; task: string; from: string; to: string };

export const NO_FILTERS: HistoryFilters = { actor: "all", factory: "", from: "", kind: "all", mode: "all", task: "", to: "" };

/** The events that pass every filter; the date range is inclusive, in local dates. */
export function filterEvents(events: readonly FactoryEvent[], filters: HistoryFilters): FactoryEvent[] {
  return events.filter((event) => {
    if (!actorMatches(event.actor, filters.actor)) return false;
    if (filters.kind === "qa" && !isQaEvent(event)) return false;
    if (filters.mode !== "all" && actorMode(event.actor) !== filters.mode) return false;
    if (filters.factory !== "" && event.factoryId !== filters.factory) return false;
    if (filters.task !== "" && event.taskId !== filters.task) return false;
    if (filters.from || filters.to) {
      const day = localDate(event.at);
      if (day === undefined) return false;
      if (filters.from && day < filters.from) return false;
      if (filters.to && day > filters.to) return false;
    }
    return true;
  });
}
