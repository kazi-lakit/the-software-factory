import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { FactoryConfig, type FactoryDef, type FactoryRepo } from "@factory/core";
import { boardStore } from "../../lib/board";

export const FACTORIES_KEY = ["board", "factories"] as const;
export const SELECTED_FACTORY_KEY = "factory-board:factory";

export type FactoryEntry = { def: FactoryDef; repos: FactoryRepo[] };

/**
 * The factories the Board shows, refreshed every 60 seconds. They are built through core's FactoryConfig, so a
 * definition that fails validation (e.g. the live gate's rows) is left out here and never listed.
 */
export function useFactories() {
  const query = useQuery({
    queryFn: async () => {
      const [defs, repos] = await Promise.all([boardStore.listFactoryDefs(), boardStore.listFactoryRepos()]);
      const config = new FactoryConfig(defs, repos);
      return config.factories().map((def): FactoryEntry => ({ def, repos: config.repos(def.factoryId) }));
    },
    queryKey: FACTORIES_KEY,
    refetchInterval: 60_000
  });
  const entries = useMemo(() => query.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.def.factoryId, entry])), [entries]);
  const defs = useMemo(() => entries.map((entry) => entry.def), [entries]);
  const repos = useMemo(() => entries.flatMap((entry) => entry.repos), [entries]);
  return { byId, defs, error: query.error, loading: query.isPending, repos };
}

const read = (): string => {
  try {
    return window.localStorage.getItem(SELECTED_FACTORY_KEY) || "all";
  } catch {
    return "all";
  }
};

/** The factory picked on the Board (`'all'` for every factory), kept in localStorage; works without it. */
export function useSelectedFactory(): [string | "all", (value: string | "all") => void] {
  const [selected, setSelected] = useState(read);
  const set = useCallback((value: string | "all") => {
    setSelected(value);
    try {
      window.localStorage.setItem(SELECTED_FACTORY_KEY, value);
    } catch {
      // Not kept; the pick still applies until the page closes.
    }
  }, []);
  return [selected, set];
}
