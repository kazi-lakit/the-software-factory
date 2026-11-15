import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { GITHUB_SCHEMA_MISSING, syncSummary, watcherState, type SyncRequest, type SyncResult } from "@factory/core";
import { boardStore } from "../../lib/board";
import { useFactoryHealth } from "../factories/useFactories";
import { useCurrentUser, userDisplayName } from "../profile/useCurrentUser";
import { useGitHubSchema, syncKey } from "./useGitHub";

/** Results the owner dismissed; in memory only, so a reload shows the latest result again. */
const dismissed = new Set<string>();
export const resetDismissedSyncsForTests = () => dismissed.clear();

function label(latest: SyncRequest | undefined, seen: boolean): string {
  if (latest?.state === "queued" || latest?.state === "planned") return "Syncing… (waiting for the factory machine)";
  if (latest?.state === "applying") return "Syncing… (applying changes)";
  return seen ? "Sync with GitHub" : "Sync with GitHub (factory machine not seen for 2+ minutes)";
}

function ResultPanel({ result, onDismiss }: { result: SyncResult; onDismiss: () => void }) {
  return (
    <div className="sf-sync-result" role="status">
      <h2 className="sf-sync-result-head">GitHub sync: {syncSummary(result)}</h2>
      <ul>
        {result.created.map((c) => <li key={`c-${c.taskId}`}>{c.taskId} created from {c.issue} ({c.status})</li>)}
        {result.applied.map((a, i) => <li key={`a-${i}`}>{a.taskId} {a.issue}: {a.change}</li>)}
        {result.notApplied.map((n, i) => <li key={`n-${i}`}>Not applied {n.taskId ?? "-"} {n.issue}: {n.change} ({n.reason})</li>)}
        {result.errors.map((e, i) => <li key={`e-${i}`}>Failed {e.taskId ?? "-"} {e.issue ?? "-"}: {e.message}</li>)}
      </ul>
      <button type="button" className="sf-button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/** Queues a Sync for a connected factory and shows its progress and result. */
export function SyncButton({ factoryId, latest }: { factoryId: string; latest: SyncRequest | undefined }) {
  const client = useQueryClient();
  const schema = useGitHubSchema();
  const health = useFactoryHealth();
  const me = useCurrentUser();
  const [problem, setProblem] = useState("");
  const [, setTick] = useState(0);
  const missing = schema.data === false;
  const syncing = latest?.state === "queued" || latest?.state === "planned" || latest?.state === "applying";
  const seen = watcherState(health.data?.find((h) => h.factoryId === factoryId), new Date()) === "seen";

  async function click() {
    setProblem("");
    try {
      await boardStore.requestSync(factoryId, userDisplayName(me.data) || "owner");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
    await client.invalidateQueries({ queryKey: syncKey(factoryId) });
  }

  const showResult = latest?.state === "applied" && latest.result && !dismissed.has(latest.requestId);
  return (
    <div className="sf-sync">
      <div className="sf-sync-row">
        <button type="button" className="sf-button" disabled={syncing || missing} onClick={() => void click()}>{label(latest, seen)}</button>
        {missing ? <span className="sf-muted">{GITHUB_SCHEMA_MISSING}</span> : null}
      </div>
      {problem ? <p className="sf-problem" role="alert">{problem}</p> : null}
      {latest?.state === "failed" ? <p className="sf-problem" role="alert">Sync failed: {latest.error ?? "unknown error"}</p> : null}
      {showResult ? <ResultPanel result={latest.result!} onDismiss={() => { dismissed.add(latest.requestId); setTick((n) => n + 1); }} /> : null}
    </div>
  );
}
