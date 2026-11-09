import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, RereadAfterUpdateError, updateHeld, VersionConflictError } from '../src/store.js';
import { runStoreContract } from './storeContract.js';

const mk = (s: MemoryStore, title = 'a') => s.createTask({ title, description: '', repo: 'data' });

runStoreContract('MemoryStore', () => new MemoryStore());
runStoreContract('FileStore', () => new FileStore(join(mkdtempSync(join(tmpdir(), 'fs-contract-')), 'board.json')));

describe('updateHeld', () => {
  test('a write that landed but could not be read back is the held task plus the patch', async () => {
    const s = new MemoryStore();
    const t = await mk(s);
    s.updateTask = async () => { throw new RereadAfterUpdateError(t.taskId); };
    expect(await updateHeld(s, t, { status: 'ready', claimBy: 'w' })).toEqual({ ...t, status: 'ready', claimBy: 'w', version: 2 });
  });
  test('other errors pass through', async () => {
    const s = new MemoryStore();
    const t = await mk(s);
    await s.updateTask(t.taskId, 1, { status: 'ready' });
    await expect(updateHeld(s, t, { status: 'spec' })).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('MemoryStore', () => {
  test('run ids are R-<n>', async () => {
    const s = new MemoryStore();
    const r = await s.startRun({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer' });
    expect(r.runId).toBe('R-1');
  });
  test('the same doc body twice makes a new version', async () => {
    const s = new MemoryStore();
    await s.addDoc('T-1', 'spec', 'one', 'me');
    expect((await s.addDoc('T-1', 'spec', 'one', 'me')).version).toBe(2);
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

  const boardPath = () => join(mkdtempSync(join(tmpdir(), 'fs-')), 'board.json');

  test('two instances on one path: a write via A is visible to B, and B keeps it when it writes later', async () => {
    const path = boardPath();
    const a = new FileStore(path);
    const t = await mk(a);
    const b = new FileStore(path); // a second CLI process
    const bt = await b.getTask('T-1');
    await b.updateTask('T-1', bt.version, { status: 'cancelled' });
    await b.addEvents([{ taskId: 'T-1', actor: 'you', action: 'move', field: 'status', from: 'inbox', to: 'cancelled', reason: 'c', at: 'now' }]);
    expect((await a.getTask('T-1')).status).toBe('cancelled');
    // A long-running process that read version 1 earlier must not overwrite the cancel.
    await expect(a.updateTask('T-1', t.version, { title: 'y' })).rejects.toBeInstanceOf(VersionConflictError);
    await a.addDoc('T-1', 'spec', 'body', 'me');
    const c = new FileStore(path);
    expect(await c.getTask('T-1')).toMatchObject({ status: 'cancelled', title: 'a' });
    expect(await c.listEvents()).toHaveLength(1);
    expect((await c.currentDoc('T-1', 'spec'))?.body).toBe('body');
  });

  test('interleaved writes from two instances all survive and leave no temp files', async () => {
    const path = boardPath();
    const a = new FileStore(path);
    const b = new FileStore(path);
    await Promise.all([mk(a, 'a1'), mk(b, 'b1'), mk(a, 'a2'), mk(b, 'b2')]);
    const ids = (await new FileStore(path).listTasks()).map((t) => t.taskId).sort();
    expect(ids).toEqual(['T-1', 'T-2', 'T-3', 'T-4']);
    expect(readdirSync(join(path, '..'))).toEqual(['board.json']);
  });

  test('a held lock makes a write fail with a clear error after the timeout', async () => {
    const path = boardPath();
    const a = new FileStore(path, { lockTimeoutMs: 100 });
    await mk(a);
    writeFileSync(`${path}.lock`, '');
    await expect(mk(a)).rejects.toThrow(/board store is locked/);
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(await a.listTasks()).toHaveLength(1);
  });

  test('a stale lock older than 30 s is removed', async () => {
    const path = boardPath();
    const a = new FileStore(path, { lockTimeoutMs: 100 });
    writeFileSync(`${path}.lock`, '');
    const old = new Date(Date.now() - 31_000);
    utimesSync(`${path}.lock`, old, old);
    await mk(a);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(await new FileStore(path).listTasks()).toHaveLength(1);
  });
});
