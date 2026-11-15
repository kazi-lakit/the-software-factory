import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { applySyncRequest, latestSync, VersionConflictError, type SyncRequest } from "@factory/core";
import { boardStore } from "../../lib/board";
import { useInvalidateAfterWrite, now } from "../task/writeOutcome";
import { GITHUB_LINKS_KEY, syncKey, syncRequestsQuery } from "./useGitHub";

/**
 * Watches the Sync requests of the connected factories and applies each planned change set once (the owner's side
 * of a Sync). Returns the newest request per factory. A second tab that loses the claim just refreshes.
 */
export function usePendingSyncs(factoryIds: string[]): Map<string, SyncRequest> {
  const client = useQueryClient();
  const invalidate = useInvalidateAfterWrite();
  const tried = useRef(new Set<string>());
  const results = useQueries({ queries: factoryIds.map((id) => syncRequestsQuery(id)) });
  const newest = new Map<string, SyncRequest>();
  factoryIds.forEach((id, i) => {
    const row = latestSync((results[i]?.data ?? []) as SyncRequest[]);
    if (row) newest.set(id, row);
  });

  const key = [...newest.values()].map((r) => `${r.requestId}:${r.state}`).join("|");
  useEffect(() => {
    for (const row of newest.values()) {
      if (row.state !== "planned" || tried.current.has(row.requestId)) continue;
      tried.current.add(row.requestId);
      void (async () => {
        try {
          await applySyncRequest(boardStore, now, row);
        } catch (e) {
          // Another tab failed the row as stale meanwhile: lost, so refresh. Any other error left the row failed (shown by its error).
          if (!(e instanceof VersionConflictError)) console.error("GitHub sync apply failed", e);
        }
        await Promise.all([invalidate(), client.invalidateQueries({ queryKey: GITHUB_LINKS_KEY }), client.invalidateQueries({ queryKey: syncKey(row.factoryId) })]);
      })();
    }
    // `key` stands for the rows' ids and states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return newest;
}
