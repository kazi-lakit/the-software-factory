import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FactoryConfig, type FactoryDef, type FactoryRepo } from "@factory/core";
import { boardStore } from "../../lib/board";

export const FACTORIES_KEY = ["board", "factories"] as const;
export const FACTORY_HEALTH_KEY = ["board", "factory-health"] as const;
export const SELECTED_FACTORY_KEY = "factory-board:factory";

export type FactoryEntry = { def: FactoryDef; repos: FactoryRepo[] };
/** A definition the Board cannot use, and why. The live gate's test rows (`GATE-…`) are never listed. */
export type SkippedDefinition = { id: string; reason: string };

/**
 * The factories the Board shows, refreshed every 60 seconds. They are built through core's FactoryConfig, so a
 * definition that fails validation (e.g. the live gate's rows) is left out here and never listed.
 */
export function useFactories() {
  const query = useQuery({
    queryFn: async () => {
      const [defs, repos] = await Promise.all([boardStore.listFactoryDefs(), boardStore.listFactoryRepos()]);
      const config = new FactoryConfig(defs, repos);
      const entries = config.factories().map((def): FactoryEntry => ({ def, repos: config.repos(def.factoryId) }));
      // Every stored repo, valid or not: a settings scope of a repo that exists is not "removed".
      const stored = new Set(repos.map((r) => `${r.factoryId}/${r.repoId}`));
      return { entries, skipped: config.skipped().filter((skip) => !skip.id.startsWith("GATE-")), stored };
    },
    queryKey: FACTORIES_KEY,
    refetchInterval: 60_000
  });
  const entries = useMemo(() => query.data?.entries ?? [], [query.data]);
  const skipped = useMemo(() => query.data?.skipped ?? [], [query.data]);
  const storedRepos = useMemo(() => query.data?.stored ?? new Set<string>(), [query.data]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.def.factoryId, entry])), [entries]);
  const defs = useMemo(() => entries.map((entry) => entry.def), [entries]);
  const repos = useMemo(() => entries.flatMap((entry) => entry.repos), [entries]);
  return { byId, defs, error: query.error, loading: query.isPending, refetch: query.refetch, repos, skipped, storedRepos };
}

/** The core's last PAT check per factory; a factory with no row has not been checked. */
export function useFactoryHealth() {
  return useQuery({
    queryFn: () => boardStore.listFactoryHealth(),
    queryKey: FACTORY_HEALTH_KEY,
    refetchInterval: 60_000
  });
}

// A pick made in this tab reaches every mounted view and the shell through these listeners. A pick made in another tab
// is not followed while the page is open (it would remount keyed Settings forms and drop their drafts); it is read on the next load.
const listeners = new Set<(value: string) => void>();
// Set only when localStorage cannot be written (private mode): the pick still applies in this tab until it closes.
let unstored: string | undefined;

const read = (): string => {
  if (unstored !== undefined) return unstored;
  try {
    return window.localStorage.getItem(SELECTED_FACTORY_KEY) || "all";
  } catch {
    return "all";
  }
};

/** The factory picked on the Board (`'all'` for every factory), kept in localStorage; works without it. */
export function useSelectedFactory(): [string | "all", (value: string | "all") => void] {
  const [selected, setSelected] = useState(read);
  useEffect(() => {
    listeners.add(setSelected);
    return () => void listeners.delete(setSelected);
  }, []);
  const set = useCallback((value: string | "all") => {
    try {
      window.localStorage.setItem(SELECTED_FACTORY_KEY, value);
      unstored = undefined;
    } catch {
      unstored = value;
    }
    for (const listener of listeners) listener(value);
  }, []);
  return [selected, set];
}
