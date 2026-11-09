
// Compare-and-set settle logic for Blocks Data conditional updates. Ported from ACR
// packages/core/src/blocks-update.ts. No Blocks imports: the caller classifies each raw answer.
//
// Blocks answers a filter non-match with `acknowledged:false, totalImpactedData:0`, and the same
// answer covers a permission denial. The response alone cannot tell "someone else won" from "not
// yours", so anything short of a clean single-row apply is settled by an owner-scoped re-read.
// The Blocks message text is never used as a signal.

export type WriteOutcome = { kind: 'applied' } | { kind: 'not-applied' } | { kind: 'unknown' };

/** `acknowledged === true && totalImpactedData === 1` is applied; `totalImpactedData === 0` is not applied; anything else is unknown. An Error means the call itself failed. */
export function classifyUpdate(r: { acknowledged?: boolean; totalImpactedData?: number } | Error): WriteOutcome {
  if (r instanceof Error) return { kind: 'unknown' };
  if (r.acknowledged === true && r.totalImpactedData === 1) return { kind: 'applied' };
  if ((r.acknowledged === false || r.acknowledged === true) && r.totalImpactedData === 0) return { kind: 'not-applied' };
  return { kind: 'unknown' };
}

/** Owner-scoped re-read of the row. `denied` covers a GraphQL error or HTTP 401/403; `failed` covers any other error or timeout. */
export type RereadResult = { rows: { version: number; writeId: string | null }[] } | { error: 'denied' | 'failed' };
export type ReconcileCode = 'CONFLICT' | 'UNAUTHORIZED' | 'RECONCILE_REQUIRED';
export type Reconciled = { outcome: 'applied' } | { outcome: 'retry' } | { outcome: 'failed'; code: ReconcileCode };

/** `writeIds` are every write this settle sent: an earlier attempt may land after a later one was sent. */
export function reconcileUpdate(reread: RereadResult, attempt: { expectedVersion: number; writeIds: string[]; isRetry: boolean }): Reconciled {
  if ('error' in reread) return { outcome: 'failed', code: reread.error === 'denied' ? 'UNAUTHORIZED' : 'RECONCILE_REQUIRED' };
  // Under owner policies a missing row and someone else's row look the same, deliberately.
  if (reread.rows.length === 0) return { outcome: 'failed', code: 'UNAUTHORIZED' };
  if (reread.rows.length > 1) return { outcome: 'failed', code: 'RECONCILE_REQUIRED' };
  const [row] = reread.rows;
  if (row!.writeId !== null && attempt.writeIds.includes(row!.writeId)) return { outcome: 'applied' };
  // The wire value is not trusted to be a number even though the type says so.
  if (typeof row!.version !== 'number') return { outcome: 'failed', code: 'RECONCILE_REQUIRED' };
  if (row!.version > attempt.expectedVersion) return { outcome: 'failed', code: 'CONFLICT' };
  if (row!.version === attempt.expectedVersion) return attempt.isRetry ? { outcome: 'failed', code: 'RECONCILE_REQUIRED' } : { outcome: 'retry' };
  return { outcome: 'failed', code: 'RECONCILE_REQUIRED' };
}

export type SettleResult =
  | { kind: 'applied' } | { kind: 'conflict' } | { kind: 'unauthorized' } | { kind: 'forbidden' } | { kind: 'reconcile'; pendingWriteIds: string[] };

/**
 * Runs one expected-version update to a settled outcome: applied, conflict (the caller must reload),
 * unauthorized, forbidden (the store refused the write: final, no re-read, no second send), or reconcile
 * (outcome unknown for now). Retries at most once, with a fresh writeId, and
 * only when the re-read proves the version did not move. Writes whose answer was unknown may still land
 * later (while the version is unmoved, at most one of them can); their ids are returned as
 * `pendingWriteIds` whenever the outcome is `reconcile`.
 */
export async function settleConditionalUpdate(p: {
  expectedVersion: number;
  send: (writeId: string) => Promise<WriteOutcome | { kind: 'forbidden' }>;
  reread: () => Promise<RereadResult>;
  newWriteId?: () => string;
  /** Lost writes of an earlier settle of the same row and version (its `pendingWriteIds`): they may have landed since. */
  priorWriteIds?: string[];
}): Promise<SettleResult> {
  const newWriteId = p.newWriteId ?? (() => globalThis.crypto.randomUUID());
  const sent: string[] = [...(p.priorWriteIds ?? [])];
  const unknown: string[] = [...sent];
  const reconcile = (): SettleResult => ({ kind: 'reconcile', pendingWriteIds: [...unknown] });
  for (const isRetry of [false, true]) {
    const writeId = newWriteId();
    sent.push(writeId);
    const answer = await p.send(writeId);
    if (answer.kind === 'applied') return { kind: 'applied' };
    // A refusal wrote nothing and would be refused again. Only an earlier write whose answer was lost can still count.
    if (answer.kind === 'forbidden') return unknown.length ? reconcile() : { kind: 'forbidden' };
    if (answer.kind === 'unknown') unknown.push(writeId);
    const reread = await p.reread();
    const settled = reconcileUpdate(reread, { expectedVersion: p.expectedVersion, writeIds: sent, isRetry });
    if (settled.outcome === 'applied') return { kind: 'applied' };
    if (settled.outcome === 'retry') continue;
    // A denied re-read says nothing about a write whose answer was lost: it may have landed before the denial.
    if (settled.code === 'UNAUTHORIZED' && 'error' in reread && unknown.length) return reconcile();
    if (settled.code === 'RECONCILE_REQUIRED') return reconcile();
    if (settled.code === 'CONFLICT') return { kind: 'conflict' };
    return { kind: 'unauthorized' };
  }
  return reconcile();
}
