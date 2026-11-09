import { describe, expect, test } from 'vitest';
import { NotFoundError, VersionConflictError, type BoardStore } from '../src/store.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';

/** Behaviour every BoardStore must share. Assertions follow the interface, not one store's internals. */
export function runStoreContract(name: string, make: () => BoardStore | Promise<BoardStore>): void {
  const mk = (s: BoardStore, title = 'a') => s.createTask({ title, description: '', repo: 'data' });

  describe(`${name} (store contract)`, () => {
    test('createTask assigns T-1, T-2 with defaults', async () => {
      const s = await make();
      const a = await mk(s);
      const b = await mk(s, 'b');
      expect([a.taskId, b.taskId]).toEqual(['T-1', 'T-2']);
      expect(a).toMatchObject({ baseBranch: 'dev', status: 'inbox', stage: null, attempt: 0, gateOverrides: {}, costUsd: 0, version: 1, claimBy: null });
      expect(await s.getTask('T-1')).toEqual(a);
      expect((await s.listTasks()).map((t) => t.taskId)).toEqual(['T-1', 'T-2']);
    });
    test('getTask throws NotFoundError', async () => {
      await expect((await make()).getTask('T-9')).rejects.toBeInstanceOf(NotFoundError);
    });
    test('updateTask bumps version; stale version throws', async () => {
      const s = await make();
      const t = await mk(s);
      const u = await s.updateTask(t.taskId, 1, { status: 'ready' });
      expect(u.version).toBe(2);
      expect(u.status).toBe('ready');
      await expect(s.updateTask(t.taskId, 1, { status: 'spec' })).rejects.toBeInstanceOf(VersionConflictError);
    });
    test('updateTask on a missing task throws NotFoundError', async () => {
      await expect((await make()).updateTask('T-9', 1, { status: 'ready' })).rejects.toBeInstanceOf(NotFoundError);
    });
    test('updateTask round-trips every field type', async () => {
      const s = await make();
      const t = await mk(s);
      const patch = {
        stage: 'build' as const, branch: 'b', prUrl: null, attempt: 2, gateOverrides: { spec: false }, costUsd: 0.1 + 0.2,
        claimBy: 'w', claimUntil: '2026-01-01T00:00:00.000Z',
      };
      const u = await s.updateTask(t.taskId, 1, patch);
      expect(u).toMatchObject(patch);
      expect(await s.getTask(t.taskId)).toEqual(u);
    });
    test('updateTask clears nullable fields with null', async () => {
      const s = await make();
      const t = await mk(s);
      const set = { stage: 'build' as const, branch: 'b', prUrl: 'u', blockedReason: 'r', question: 'q', answer: 'a', claimBy: 'w', claimUntil: '2026-01-01T00:00:00.000Z' };
      const u = await s.updateTask(t.taskId, 1, set);
      const cleared = Object.fromEntries(Object.keys(set).map((k) => [k, null]));
      expect(await s.updateTask(t.taskId, u.version, cleared)).toMatchObject(cleared);
      expect(await s.getTask(t.taskId)).toMatchObject(cleared);
    });
    test('updateTask rejects taskId/version in patch', async () => {
      const s = await make();
      const t = await mk(s);
      await expect(s.updateTask(t.taskId, 1, { version: 9 })).rejects.toThrow();
    });
    test('returned tasks are copies', async () => {
      const s = await make();
      const t = await mk(s);
      t.title = 'x';
      expect((await s.getTask('T-1')).title).toBe('a');
    });
    test('addDoc versions and supersedes', async () => {
      const s = await make();
      const d1 = await s.addDoc('T-1', 'spec', 'one', 'me');
      const d2 = await s.addDoc('T-1', 'spec', 'two', 'me');
      expect([d1.version, d2.version]).toEqual([1, 2]);
      expect(await s.currentDoc('T-1', 'spec')).toEqual({ taskId: 'T-1', kind: 'spec', version: 2, body: 'two', author: 'me', status: 'current' });
      expect(await s.currentDoc('T-1', 'plan')).toBeUndefined();
    });
    test('approvals get a timestamp', async () => {
      const s = await make();
      const a = await s.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
      expect(a.at).toMatch(/^\d{4}-/);
      expect(await s.listApprovals('T-1')).toEqual([a]);
      expect(await s.listApprovals('T-2')).toHaveLength(0);
    });
    test('addApproval with the same approvalId twice records one approval', async () => {
      const s = await make();
      const a = { taskId: 'T-1', gate: 'spec' as const, docVersion: 1, decision: 'approve' as const, comment: '', approvalId: 'x-1' };
      const first = await s.addApproval(a);
      expect(first).not.toHaveProperty('approvalId');
      expect(await s.addApproval(a)).toEqual(first);
      expect(await s.listApprovals('T-1')).toEqual([first]);
    });
    test('empty store settings are defaults', async () => {
      expect(await (await make()).getSettings()).toEqual({ global: DEFAULT_SETTINGS, repos: {} });
    });
    test('setSettings roundtrip', async () => {
      const s = await make();
      const stored = { global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } };
      await s.setSettings(stored);
      expect(await s.getSettings()).toEqual(stored);
      const next = { global: { ...DEFAULT_SETTINGS, maxParallel: 4 }, repos: { os: { gates: { pr: false } } } };
      await s.setSettings(next);
      expect(await s.getSettings()).toEqual(next);
    });
    // Run ids are store-specific (MemoryStore: R-<n>; BlocksStore: R-<uuid>), so only the returned id is used.
    test('runs: start, open, finish', async () => {
      const s = await make();
      const r = await s.startRun({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer' });
      expect(r).toMatchObject({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer', endedAt: null, result: null, turns: null, costUsd: null });
      expect(r.runId).toMatch(/^R-/);
      expect(await s.openRun('T-1', 'build')).toEqual(r);
      expect(await s.openRun('T-1', 'spec')).toBeUndefined();
      await s.finishRun(r.runId, { result: 'done', turns: 3, costUsd: 0.5 });
      expect(await s.openRun('T-1', 'build')).toBeUndefined();
    });
    test('finishRun on a missing run throws NotFoundError', async () => {
      await expect((await make()).finishRun('R-missing', { result: 'done', turns: null, costUsd: null })).rejects.toBeInstanceOf(NotFoundError);
    });
    test('events append and filter', async () => {
      const s = await make();
      const e = { actor: 'x', action: 'set' as const, field: 'stage', from: null, to: 'a', reason: '', at: 't' };
      await s.addEvents([{ taskId: 'T-1', ...e }, { taskId: 'T-2', ...e }]);
      expect(await s.listEvents()).toHaveLength(2);
      expect(await s.listEvents('T-2')).toEqual([{ taskId: 'T-2', ...e }]);
    });
  });
}
