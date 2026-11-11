import { useQuery } from "@tanstack/react-query";
import type { FactoryEvent } from "@factory/core";
import { boardStore } from "../../lib/board";
import { isTestTask } from "../board/status";
import { isQaEvent } from "../../lib/qaEvent";
import { describeEvent } from "../../lib/describeEvent";
import { localDay } from "../../lib/formatTime";

/** Every history query starts with this key; a settings save invalidates them all. */
export const HISTORY_KEY = ["history"] as const;

/** The task id settings events are stored under. */
export const SETTINGS_TASK = "-";

export type HistoryData = {
  /** Every event of the listed tasks and the settings, newest first. */
  events: FactoryEvent[];
  /** The tasks whose events were read, for the task filter. */
  taskIds: string[];
  /** Task id to title, for the search. */
  titles: Record<string, string>;
  /** Whether any GATE-* test task exists, read before the test filter. */
  hasTestTasks: boolean;
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
  const all = await boardStore.listTasks();
  const hasTestTasks = all.some(isTestTask);
  const tasks = all.filter((task) => showTest || !isTestTask(task));
  const taskIds = tasks.map((task) => task.taskId).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const titles = Object.fromEntries(tasks.map((task) => [task.taskId, task.title]));
  const lists = await mapLimit([...taskIds, SETTINGS_TASK], PARALLEL_READS, (taskId) => boardStore.listEvents(taskId));
  return { events: newestFirst(lists), hasTestTasks, taskIds, titles };
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

// Actor text: "you", "core · <mode>", "core · new", or "<agent> · <mode> · run <runId>".
export const ACTOR_FILTERS = ["you", "spec-writer", "planner", "implementer", "verifier", "reviewer", "core"] as const;
export type ActorFilter = (typeof ACTOR_FILTERS)[number] | "all";

export function actorMatches(actor: string, filter: ActorFilter): boolean {
  if (filter === "all") return true;
  if (filter === "core") return actor.startsWith("core");
  return actor.split(" · ")[0] === filter;
}

export type WhenFilter = "today" | "7d" | "30d" | "all";
export type PillFilter = "all" | "you" | "qa" | "moves" | "settings";

export type HistoryFilters = { search: string; actor: ActorFilter; task: string; when: WhenFilter; pill: PillFilter; factory: string };

export const NO_FILTERS: HistoryFilters = { actor: "all", factory: "", pill: "all", search: "", task: "", when: "7d" };

export type FilterContext = {
  /** Task id to title, for the search. */
  titles?: Readonly<Record<string, string>>;
  /** The change sentence of an event, for the search; defaults to `describeEvent(event).text`. */
  changeText?: (event: FactoryEvent) => string;
  /** The time the When filter counts back from; defaults to now. */
  now?: Date;
};

// How many days before today each When choice reaches back to, in local calendar dates.
const WHEN_DAYS: Readonly<Record<Exclude<WhenFilter, "all">, number>> = { "30d": 29, "7d": 6, today: 0 };

function pillMatches(event: FactoryEvent, pill: PillFilter): boolean {
  switch (pill) {
    case "all": return true;
    case "you": return event.actor === "you";
    case "qa": return isQaEvent(event);
    case "moves": return event.action === "move";
    case "settings": return event.taskId === SETTINGS_TASK;
  }
}

/** The events that pass every filter. The When filter works on local calendar dates. */
export function filterEvents(events: readonly FactoryEvent[], filters: HistoryFilters, context: FilterContext = {}): FactoryEvent[] {
  const now = context.now ?? new Date();
  const titles = context.titles ?? {};
  const changeText = context.changeText ?? ((event: FactoryEvent) => describeEvent(event).text);
  const cutoff = filters.when === "all" ? undefined : localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - WHEN_DAYS[filters.when]));
  const query = filters.search.trim().toLowerCase();
  return events.filter((event) => {
    if (!actorMatches(event.actor, filters.actor)) return false;
    if (!pillMatches(event, filters.pill)) return false;
    if (filters.factory !== "" && event.factoryId !== filters.factory) return false;
    if (filters.task !== "" && event.taskId !== filters.task) return false;
    if (cutoff !== undefined) {
      const date = new Date(event.at);
      if (Number.isNaN(date.getTime()) || localDay(date) < cutoff) return false;
    }
    if (query !== "") {
      const haystack = [event.taskId, titles[event.taskId] ?? "", changeText(event), event.reason];
      if (!haystack.some((text) => text.toLowerCase().includes(query))) return false;
    }
    return true;
  });
}
