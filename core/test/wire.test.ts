import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { BlocksCredential } from '../src/blocks/credential.js';
import { LazyBlocksStore, wire } from '../src/wire.js';
import { MemoryStore, type BoardStore } from '../src/store.js';

const cred: BlocksCredential = { clientId: 'i', clientSecret: 's', projectKey: 'p', apiUrl: 'u' };

describe('LazyBlocksStore', () => {
  test('concurrent first calls load the credential once', async () => {
    const load = vi.fn(async () => cred);
    const lazy = new LazyBlocksStore(load, () => new MemoryStore());
    await Promise.all([lazy.listTasks(), lazy.listTasks(), lazy.getSettings()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a rejected load is not cached', async () => {
    const load = vi.fn<() => Promise<BlocksCredential>>().mockRejectedValueOnce(new Error('no keychain')).mockResolvedValue(cred);
    const lazy = new LazyBlocksStore(load, () => new MemoryStore());
    await expect(lazy.listTasks()).rejects.toThrow('no keychain');
    await expect(lazy.listTasks()).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('every BoardStore method delegates with the same arguments', async () => {
    const calls: [string, unknown[]][] = [];
    const inner = new Proxy({}, { get: (_t, name: string) => name === 'then' ? undefined : async (...args: unknown[]) => { calls.push([name, args]); return `r:${name}`; } }) as unknown as BoardStore;
    const lazy = new LazyBlocksStore(async () => cred, () => inner);
    const cases: [keyof BoardStore, unknown[]][] = [
      ['listTasks', []], ['getTask', ['T-1']], ['createTask', [{ title: 't', description: 'd', repo: 'data' }]],
      ['updateTask', ['T-1', 2, { status: 'ready' }]], ['addDoc', ['T-1', 'spec', 'b', 'a']], ['currentDoc', ['T-1', 'spec']],
      ['addApproval', [{ taskId: 'T-1' }]], ['listApprovals', ['T-1']], ['getSettings', []], ['setSettings', [{}]],
      ['startRun', [{ taskId: 'T-1' }]], ['openRun', ['T-1', 'spec']], ['finishRun', ['R-1', { result: 'done' }]],
      ['addEvents', [[]]], ['listEvents', ['T-1']],
    ];
    expect(cases).toHaveLength(15);
    for (const [name, args] of cases) {
      expect(await (lazy[name] as (...a: unknown[]) => Promise<unknown>)(...args)).toBe(`r:${name}`);
    }
    expect(calls).toEqual(cases);
  });

  test("wire({store:'blocks'}) builds a lazy store without loading the credential", async () => {
    const loadCredential = vi.fn(async () => cred);
    const { store } = await wire({ root: resolve(import.meta.dirname, '..', '..'), mode: 'session', store: 'blocks', loadCredential });
    expect(store).toBeInstanceOf(LazyBlocksStore);
    expect(loadCredential).not.toHaveBeenCalled();
  });
});
