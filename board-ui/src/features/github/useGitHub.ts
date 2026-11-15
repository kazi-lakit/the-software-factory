import { useQuery } from "@tanstack/react-query";
import { latestSync, type SyncRequest } from "@factory/core";
import { boardStore } from "../../lib/board";

export const GITHUB_SCHEMA_KEY = ["board", "github-schema"] as const;
export const GITHUB_LINKS_KEY = ["board", "github-links"] as const;
export const syncKey = (factoryId: string | null) => ["board", "github-sync", factoryId] as const;

/** Whether the GitHub tables exist in Blocks Data; checked at most once a minute. */
export function useGitHubSchema() {
  return useQuery({ queryFn: () => boardStore.githubSchemaReady(), queryKey: GITHUB_SCHEMA_KEY, staleTime: 60_000 });
}

/** Every task's GitHub link, every 30 s; `enabled` is false while no factory is connected. */
export function useGitHubLinks(enabled: boolean) {
  return useQuery({ enabled, queryFn: () => boardStore.listGitHubLinks(), queryKey: GITHUB_LINKS_KEY, refetchInterval: 30_000 });
}

const BUSY = new Set(["queued", "planned", "applying"]);

/** A factory's Sync requests: every 2 s while the latest is in flight, else every 30 s. */
export function useSyncRequests(factoryId: string | null) {
  return useQuery({
    enabled: factoryId !== null,
    queryFn: () => boardStore.listSyncRequests(factoryId ?? undefined),
    queryKey: syncKey(factoryId),
    refetchInterval: (query) => {
      const latest = latestSync((query.state.data ?? []) as SyncRequest[]);
      return latest && BUSY.has(latest.state) ? 2_000 : 30_000;
    }
  });
}
