import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { applySyncRequest, latestSync, VersionConflictError, type SyncRequest } from "@factory/core";
import { boardStore } from "../../lib/board";
import { useInvalidateAfterWrite, now } from "../task/writeOutcome";
import { GITHUB_LINKS_KEY, syncKey, syncRequestsQuery } from "./useGitHub";

async function stillPlanned(row: SyncRequest): Promise<boolean> {
  try {
    return (await boardStore.listSyncRequests(row.factoryId)).some((r) => r.requestId === row.requestId && r.state === "planned");
  } catch {
    return false;
  }
}

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

  // Each poll re-runs the effect, so a request taken out of `tried` after a failed claim is tried again.
  const key = [...newest.values()].map((r) => `${r.requestId}:${r.state}`).join("|") + `@${results.map((r) => r.dataUpdatedAt).join(",")}`;
  useEffect(() => {
    for (const row of newest.values()) {
      if (row.state !== "planned" || tried.current.has(row.requestId)) continue;
      tried.current.add(row.requestId);
      void (async () => {
        try {
          await applySyncRequest(boardStore, now, row);
        } catch (e) {
          // Another tab claimed it or the factory machine failed it meanwhile: lost, so refresh.
          if (!(e instanceof VersionConflictError)) {
            console.error("GitHub sync apply failed", e);
            // The claim never happened (the row is still planned): nothing changed, so try again on the next regular poll
            // (no refresh now, which would retry at once). Otherwise the row shows its error.
            if (await stillPlanned(row)) {
              tried.current.delete(row.requestId);
              return;
            }
          }
        }
        await Promise.all([invalidate(), client.invalidateQueries({ queryKey: GITHUB_LINKS_KEY }), client.invalidateQueries({ queryKey: syncKey(row.factoryId) })]);
      })();
    }
    // `key` stands for the rows' ids and states and the poll times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return newest;
}
