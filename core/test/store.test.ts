import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, NotFoundError, VersionConflictError } from '../src/store.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';

const mk = (s: MemoryStore, title = 'a') => s.createTask({ title, description: '', repo: 'data' });

describe('MemoryStore', () => {
  test('createTask assigns T-1, T-2 with defaults', async () => {
    const s = new MemoryStore();
    const a = await mk(s);
    const b = await mk(s, 'b');
    expect([a.taskId, b.taskId]).toEqual(['T-1', 'T-2']);
    expect(a).toMatchObject({ baseBranch: 'dev', status: 'inbox', stage: null, attempt: 0, gateOverrides: {}, costUsd: 0, version: 1, claimBy: null });
  });
  test('getTask throws NotFoundError', async () => {
    await expect(new MemoryStore().getTask('T-9')).rejects.toBeInstanceOf(NotFoundError);
  });
  test('updateTask bumps version; stale version throws', async () => {
    const s = new MemoryStore();
    const t = await mk(s);
    const u = await s.updateTask(t.taskId, 1, { status: 'ready' });
    expect(u.version).toBe(2);
    await expect(s.updateTask(t.taskId, 1, { status: 'spec' })).rejects.toBeInstanceOf(VersionConflictError);
  });
  test('updateTask rejects taskId/version in patch', async () => {
    const s = new MemoryStore();
    const t = await mk(s);
    await expect(s.updateTask(t.taskId, 1, { version: 9 })).rejects.toThrow();
  });
  test('returned tasks are copies', async () => {
    const s = new MemoryStore();
    const t = await mk(s);
    t.title = 'x';
    expect((await s.getTask('T-1')).title).toBe('a');
  });
  test('addDoc versions and supersedes', async () => {
    const s = new MemoryStore();
    const d1 = await s.addDoc('T-1', 'spec', 'one', 'me');
    const d2 = await s.addDoc('T-1', 'spec', 'two', 'me');
    expect([d1.version, d2.version]).toEqual([1, 2]);
    expect((await s.currentDoc('T-1', 'spec'))?.body).toBe('two');
    expect(await s.currentDoc('T-1', 'plan')).toBeUndefined();
  });
  test('approvals get a timestamp', async () => {
    const s = new MemoryStore();
    const a = await s.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
    expect(a.at).toMatch(/^\d{4}-/);
    expect(await s.listApprovals('T-1')).toHaveLength(1);
    expect(await s.listApprovals('T-2')).toHaveLength(0);
  });
  test('empty store settings are defaults', async () => {
    expect(await new MemoryStore().getSettings()).toEqual({ global: DEFAULT_SETTINGS, repos: {} });
  });
  test('setSettings roundtrip', async () => {
    const s = new MemoryStore();
    await s.setSettings({ global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } });
    expect((await s.getSettings()).global.paused).toBe(true);
  });
  test('runs: start, open, finish', async () => {
    const s = new MemoryStore();
    const r = await s.startRun({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer' });
    expect(r).toMatchObject({ runId: 'R-1', endedAt: null, result: null, turns: null, costUsd: null });
    expect((await s.openRun('T-1', 'build'))?.runId).toBe('R-1');
    await s.finishRun('R-1', { result: 'done', turns: 3, costUsd: 0.5 });
    expect(await s.openRun('T-1', 'build')).toBeUndefined();
  });
  test('events append and filter', async () => {
    const s = new MemoryStore();
    const e = { actor: 'x', action: 'set' as const, field: 'stage', from: null, to: 'a', reason: '', at: 't' };
    await s.addEvents([{ taskId: 'T-1', ...e }, { taskId: 'T-2', ...e }]);
    expect(await s.listEvents()).toHaveLength(2);
    expect(await s.listEvents('T-2')).toHaveLength(1);
  });
});

describe('FileStore', () => {
  test('reloads what an earlier instance wrote', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fs-')), 'sub', 'board.json');
    const a = new FileStore(path);
    await mk(a);
    await a.addDoc('T-1', 'spec', 'body', 'me');
    await a.startRun({ taskId: 'T-1', step: 'spec', mode: 'sdk', agent: 'x' });
    const b = new FileStore(path);
    expect((await b.listTasks()).map((t) => t.taskId)).toEqual(['T-1']);
    expect((await b.currentDoc('T-1', 'spec'))?.body).toBe('body');
    expect((await b.createTask({ title: 'n', description: '', repo: 'os' })).taskId).toBe('T-2');
    expect((await b.startRun({ taskId: 'T-1', step: 'spec', mode: 'sdk', agent: 'x' })).runId).toBe('R-2');
  });
});
