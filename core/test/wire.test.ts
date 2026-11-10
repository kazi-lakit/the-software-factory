import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { BlocksCredential } from '../src/blocks/credential.js';
import { PatMissingError, SecretMissingError } from '../src/secrets.js';
import { FakeGitHub } from '../src/github.js';
import { lazyGitHubFor, LazyBlocksStore, wire } from '../src/wire.js';
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

  test('a failed load clears only itself: a newer load is kept, not loaded again', async () => {
    const load = vi.fn<() => Promise<BlocksCredential>>().mockRejectedValueOnce(new Error('no keychain')).mockResolvedValue(cred);
    const lazy = new LazyBlocksStore(load, () => new MemoryStore());
    const failed = () => 'failed';
    // A call that arrives after the first load failed but before its handler ran used to attach another failure
    // handler to it; that stale handler then dropped the load a later call had started, so it loaded a third time.
    const ticks = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    const later = (n: number) => (async () => { await ticks(n); return lazy.listTasks().catch(failed); })();
    const first = lazy.listTasks().catch(failed);
    const stale = later(1);
    const newer = later(0);
    await Promise.all([first, stale, newer]);
    await lazy.listTasks();
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
      ['addEvents', [[]]], ['listEvents', ['T-1']], ['listDocs', ['T-1', 'spec']], ['listRuns', ['T-1']],
      ['updateSettingsScope', ['data', undefined, { maxParallel: 1 }]],
    ];
    expect(cases).toHaveLength(18);
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

describe('findRoot', () => {
  test('a root has core/ and plugin/; repos/ is not needed', async () => {
    const { mkdtempSync, mkdirSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { findRoot } = await import('../src/wire.js');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'findroot-')));
    mkdirSync(join(root, 'core'));
    mkdirSync(join(root, 'plugin'));
    mkdirSync(join(root, 'core', 'src'), { recursive: true });
    expect(findRoot(join(root, 'core', 'src'), {})).toBe(root);
  });
});

describe('lazyGitHubFor', () => {
  test('reads no secret until a call, then once per account, and one client per account', async () => {
    const reads: string[] = [];
    const made: string[] = [];
    const githubFor = lazyGitHubFor(async (acct) => { reads.push(acct); return `pat-${acct}`; }, (pat) => { made.push(pat); return new FakeGitHub(); });
    const a = githubFor('github-pat:a');
    expect(githubFor('github-pat:a')).toBe(a);
    expect(githubFor('github-pat:b')).not.toBe(a);
    expect(reads).toEqual([]);
    await a.prState('https://github.com/o/r/pull/1').catch(() => undefined);
    await a.prState('https://github.com/o/r/pull/1').catch(() => undefined);
    expect(reads).toEqual(['github-pat:a']);
    expect(made).toEqual(['pat-github-pat:a']);
  });

  test('a missing secret becomes PatMissingError, and the reserved account is refused', async () => {
    const githubFor = lazyGitHubFor(async () => { throw new SecretMissingError('x not found'); }, () => new FakeGitHub());
    const err = await githubFor('github-pat:a').ensureReady!().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PatMissingError);
    expect(err).toMatchObject({ account: 'github-pat:a', message: 'PAT github-pat:a not in Keychain' });
    expect(() => githubFor(' Blocks-Credential ')).toThrow('patAccount blocks-credential is reserved');
    expect(() => githubFor('blocks-credential')).toThrow('patAccount blocks-credential is reserved');
  });

  test('a failed read is not cached', async () => {
    const read = vi.fn<(acct: string) => Promise<string>>().mockRejectedValueOnce(new Error('missing')).mockResolvedValue('t');
    const a = lazyGitHubFor(read, () => new FakeGitHub())('x');
    await expect(a.prState('https://github.com/o/r/pull/1')).rejects.toThrow('missing');
    await expect(a.prState('https://github.com/o/r/pull/1')).rejects.toThrow('unknown pull request');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
