import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { defFixture, repoFixture, seed, seedBlocksFactories } from './factoryFixtures.js';
import type { Exec } from '../src/checks.js';
import type { ExecFile } from '../src/secrets.js';
import { buildImport } from '../src/migrate.js';
import { run, type WireOptions } from '../src/cli.js';
import { Engine } from '../src/engine.js';
import { FactoryConfig } from '../src/factories.js';
import type { GitRepos } from '../src/git.js';
import { FakeGitHub } from '../src/github.js';
import { BlocksStore } from '../src/blocks/store.js';
import { FakeBlocksData, newFakeStorage } from '../src/blocks/fakeData.js';
import { MemoryStore } from '../src/store.js';
import type { RepoId, Task } from '../src/types.js';

const ROOT = join(tmpdir(), 'factory-cli-test');
const git: GitRepos = {
  ensureClone: async (f, c) => join(ROOT, '.clones', f, c.repoId),
  worktree: async (_f, _c, taskId) => join(ROOT, '.clones', 'worktrees', taskId),
  push: async () => {},
  isClean: async () => true,
};

/** A fake `security`: only the listed accounts exist (value `secret`). It never touches the real Keychain. */
const fakeSecurity = (initial: string[] = ['github-pat:blocks']): ExecFile => {
  const accounts = new Set(initial);
  return async (_file, args, stdin) => {
    if (args[0] === '-i') {
      accounts.add(/ -a (\S+) /.exec(stdin ?? '')?.[1] ?? '');
      return { code: 0, stdout: '', stderr: '' };
    }
    return accounts.has(args[args.indexOf('-a') + 1] ?? '') ? { code: 0, stdout: 'secret\n', stderr: '' } : { code: 44, stdout: '', stderr: '' };
  };
};

function setup(factories = seed(), accounts?: string[], securityCalls?: string[][]) {
  const store = new MemoryStore({ factories });
  const exec: Exec = async () => ({ code: 0, output: '' });
  const engine = new Engine({
    store, git, githubFor: () => new FakeGitHub(), factories: async () => new FactoryConfig(factories.defs, factories.repos),
    exec, now: () => new Date(), mode: 'session', claimant: 'me',
  });
  const wired: WireOptions[] = [];
  const makeEngine = async (o: WireOptions) => {
    wired.push(o);
    return { engine, store };
  };
  const out: string[] = [];
  const err: string[] = [];
  const security = fakeSecurity(accounts);
  const exec2: ExecFile = (file, args, stdin) => {
    securityCalls?.push(args);
    return security(file, args, stdin);
  };
  const go = (...argv: string[]) => run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, makeEngine, { exec: exec2 });
  return { store, out, err, go, wired };
}

const put = async (store: MemoryStore, patch: Partial<Task>) => {
  const t = await store.createTask({ factoryId: 'blocks', title: 'Add widget', description: 'd', repo: 'data' });
  return store.updateTask(t.taskId, t.version, patch);
};

// The CLI reads these from the environment; clear them so the suite passes with or without them exported.
const AMBIENT = ['FACTORY_STORE', 'FACTORY_ROOT', 'FACTORY_CLAIMANT'] as const;
const ambient: Partial<Record<(typeof AMBIENT)[number], string>> = {};
beforeAll(() => {
  for (const k of AMBIENT) {
    if (process.env[k] !== undefined) ambient[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of AMBIENT) {
    if (ambient[k] === undefined) delete process.env[k];
    else process.env[k] = ambient[k];
  }
});

describe('factory cli', () => {
  test('next --json prints a ticket at the spec step', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).step).toBe('spec');
  });

  test('next prints a short line, and nothing to do when idle', async () => {
    const { store, out, go } = setup();
    expect(await go('next')).toBe(0);
    expect(out).toEqual(['nothing to do']);
    await put(store, { status: 'ready' });
    await go('next');
    expect(out[1]).toMatch(/^T-1 spec \(worktree .*T-1\)$/);
  });

  test('next prints paused when the factory is paused', async () => {
    const { store, out, go } = setup();
    await store.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    await put(store, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(out).toEqual(['paused']);
    expect((await store.getTask('T-1')).claimBy).toBeNull();
  });

  test('next with no factory definitions prints the migrate hint and leaves the task ready', async () => {
    const { store, out, go } = setup({ defs: [], repos: [] });
    await put(store, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(out).toEqual(['no factories on the Board; run factory migrate --check']);
    expect((await store.getTask('T-1')).status).toBe('ready');
  });

  test('next --factory limits the pass to the named factories; an unknown one exits 1', async () => {
    const { store, out, err, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('next', '--factory', 'other')).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['unknown factory other']);
    expect((await store.getTask('T-1')).claimBy).toBeNull();
    expect(await go('next', '--factory', 'blocks', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ taskId: 'T-1', context: { factory: { factoryId: 'blocks' } } });
  });

  test('complete with a missing result file blocks the task', async () => {
    const { store, go } = setup();
    await put(store, { status: 'ready' });
    await go('next');
    expect(await go('complete', 'T-1', 'spec', '--result', 'missing.json')).toBe(0);
    const t = await store.getTask('T-1');
    expect(t.status).toBe('blocked');
    expect(t.blockedReason).toMatch(/^invalid agent result/);
  });

  const replyFile = (text: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'factory-reply-')), 'reply.txt');
    writeFileSync(f, text);
    return f;
  };
  const SPEC_REPLY = '<factory-result>\n{"status":"done","summary":"s"}\n</factory-result>\n<factory-doc>\n# Spec\n</factory-doc>';

  test('complete --reply records the doc like --result', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    await go('next');
    expect(await go('complete', 'T-1', 'spec', '--reply', replyFile(SPEC_REPLY))).toBe(0);
    expect(out.at(-1)).toBe('T-1 spec_review');
    expect(await store.currentDoc('T-1', 'spec')).toMatchObject({ body: '# Spec' });
  });

  test('complete needs exactly one of --result or --reply', async () => {
    const { err, go } = setup();
    expect(await go('complete', 'T-1', 'spec')).toBe(1);
    expect(await go('complete', 'T-1', 'spec', '--result', 'a.json', '--reply', 'b.txt')).toBe(1);
    expect(err).toEqual(['error: pass exactly one of --result or --reply', 'error: pass exactly one of --result or --reply']);
  });

  describe('FACTORY_STORE', () => {
    afterEach(() => {
      delete process.env.FACTORY_STORE;
    });

    test('is the default store, and an explicit --store wins', async () => {
      const { go, wired } = setup();
      process.env.FACTORY_STORE = 'blocks';
      await go('status');
      await go('--store', 'file', 'status');
      expect(wired.map((w) => w.store)).toEqual(['blocks', 'file']);
    });

    test('an empty value defaults to the file store', async () => {
      const { go, wired } = setup();
      process.env.FACTORY_STORE = '';
      expect(await go('status')).toBe(0);
      expect(wired.map((w) => w.store)).toEqual(['file']);
    });

    test('an invalid value exits 1', async () => {
      const { err, go } = setup();
      process.env.FACTORY_STORE = 'nope';
      expect(await go('status')).toBe(1);
      expect(err).toEqual(['error: --store must be one of file, blocks']);
    });
  });

  test('dev approve for a missing doc exits 1', async () => {
    const { store, err, go } = setup();
    await put(store, { status: 'spec_review', stage: 'spec' });
    expect(await go('dev', 'approve', 'T-1', 'plan')).toBe(1);
    expect(err.join('\n')).toMatch(/no current plan doc/);
  });

  test('status --store blocks runs on an injected BlocksStore', async () => {
    const { out, wired } = setup();
    const store = new BlocksStore(new FakeBlocksData('factory-core'), 'core');
    const engine = new Engine({
      store, git, githubFor: () => new FakeGitHub(), factories: async () => new FactoryConfig(seed().defs, seed().repos),
      exec: async () => ({ code: 0, output: '' }), now: () => new Date(), mode: 'session', claimant: 'me',
    });
    const go = (...argv: string[]) =>
      run(argv, { out: (s) => out.push(s), err: () => {} }, async (o) => { wired.push(o); return { engine, store }; }, { exec: fakeSecurity() });
    expect(await go('--store', 'blocks', 'status')).toBe(0);
    expect(wired[0]).toMatchObject({ store: 'blocks' });
    expect(out.length).toBeGreaterThan(0);
  });

  test('dev commands with --store blocks exit 1 before any store is built', async () => {
    const { err, go, wired } = setup();
    expect(await go('--store', 'blocks', 'dev', 'add', '--repo', 'data', '--title', 'X')).toBe(1);
    expect(await go('--store', 'blocks', 'dev', 'cancel', 'T-1')).toBe(1);
    expect(err).toEqual(['error: dev commands need --store file', 'error: dev commands need --store file']);
    expect(wired).toHaveLength(0);
  });

  test('the engine log goes to stderr', async () => {
    const { err, go, wired } = setup();
    await go('status');
    wired[0]!.log!('sync: skipped T-1: GitHub down');
    expect(err).toEqual(['sync: skipped T-1: GitHub down']);
  });

  test('status prints blocked tasks with their questions', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'blocked', stage: 'verify', question: 'AC3: which API?' });
    await put(store, { status: 'blocked', stage: 'build', blockedReason: 'returned to build 3 times', question: 'tests fail' });
    await go('status');
    expect(out).toContain('blocked: T-1 at verify, question: AC3: which API?');
    expect(out).toContain('blocked: T-2 at build (returned to build 3 times), question: tests fail');
  });

  test('ship against a branch dev exits 1 with one line', async () => {
    const { store, err, go } = setup();
    await put(store, {
      status: 'review', stage: 'ship', branch: 'dev', claimBy: 'me',
      claimUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await go('ship', 'T-1')).toBe(1);
    expect(err).toEqual(['error: push to dev refused (protected branch)']);
  });

  test('dev add, ready, approve, answer, cancel write events as you', async () => {
    const { store, out, err, go } = setup();
    expect(await go('dev', 'add', '--repo', 'data', '--title', 'X', '--description', 'd')).toBe(0);
    expect(await go('dev', 'ready', 'T-1')).toBe(0);
    expect((await store.getTask('T-1')).status).toBe('ready');

    await put(store, { status: 'spec_review', stage: 'spec' });
    await store.addDoc('T-2', 'spec', 'S', 'a');
    expect(await go('dev', 'approve', 'T-2', 'spec')).toBe(0);
    expect(await store.listApprovals('T-2')).toMatchObject([{ gate: 'spec', docVersion: 1, decision: 'approve' }]);
    const ev = (await store.listEvents('T-2')).find((e) => e.field === 'approval');
    expect(ev).toMatchObject({ actor: 'you', action: 'set', to: 'spec:approve@v1' });

    expect(await go('dev', 'answer', 'T-2', 'hi')).toBe(1);
    expect(err.at(-1)).toBe('error: T-2 is not blocked');
    await store.updateTask('T-2', (await store.getTask('T-2')).version, { status: 'blocked' });
    expect(await go('dev', 'answer', 'T-2', 'hi')).toBe(0);
    expect((await store.getTask('T-2')).answer).toBe('hi');

    expect(await go('dev', 'cancel', 'T-2')).toBe(0);
    expect((await store.getTask('T-2')).status).toBe('cancelled');
    expect(await go('dev', 'ready', 'T-2')).toBe(1);
    expect(out.length).toBeGreaterThan(0);
  });

  test('dev commands keep the owner rules: a blank title, a task not at the gate and a blank answer exit 1', async () => {
    const { store, err, go } = setup();
    expect(await go('dev', 'add', '--repo', 'data', '--title', ' ')).toBe(1);
    expect(err.at(-1)).toBe('error: title must not be blank');
    expect(await store.listTasks()).toEqual([]);

    await put(store, { status: 'plan_review', stage: 'plan' });
    await store.addDoc('T-1', 'spec', 'S', 'a');
    expect(await go('dev', 'approve', 'T-1', 'spec')).toBe(1);
    expect(err.at(-1)).toBe('error: T-1 is not waiting at the spec gate');
    expect(await store.listApprovals('T-1')).toEqual([]);

    await store.updateTask('T-1', (await store.getTask('T-1')).version, { status: 'blocked' });
    expect(await go('dev', 'answer', 'T-1', ' ')).toBe(1);
    expect(err.at(-1)).toBe('error: answer must not be blank');
  });

  test('dev approve --changes records the comment as the event reason', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'plan_review', stage: 'plan' });
    await store.addDoc('T-1', 'plan', 'P', 'a');
    expect(await go('dev', 'approve', 'T-1', 'plan', '--changes', 'split step 3')).toBe(0);
    expect(out).toEqual(['T-1 plan changes v1']);
    expect((await store.listEvents('T-1')).find((e) => e.field === 'approval')).toMatchObject({ to: 'plan:changes@v1', reason: 'split step 3' });
  });

  test('renew extends the held claim and prints the new claimUntil', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', claimBy: 'me', claimUntil: new Date(Date.now() + 1000).toISOString() });
    expect(await go('renew', 'T-1')).toBe(0);
    const t = await store.getTask('T-1');
    expect(Date.parse(t.claimUntil!)).toBeGreaterThan(Date.now() + 500_000);
    expect(out).toEqual([`T-1 claimed until ${t.claimUntil}`]);
  });

  test('renew of a claim not held exits 1 with one line', async () => {
    const { store, err, go } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', claimBy: 'other', claimUntil: new Date(Date.now() + 1000).toISOString() });
    expect(await go('renew', 'T-1')).toBe(1);
    expect(err).toEqual(['error: T-1 is not claimed by me']);
    expect((await store.getTask('T-1')).claimBy).toBe('other');
  });

  test('status --json and plain', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('status', '--json')).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json.counts).toEqual({ ready: 1 });
    expect(json.tasks).toMatchObject([{ taskId: 'T-1', status: 'ready' }]);
    expect(json.factories).toMatchObject([{ factoryId: 'blocks', name: 'blocks', active: true, paused: false, counts: { ready: 1 }, patPresent: true }]);
    await go('status');
    expect(out.slice(1).join('\n')).toMatch(/factory blocks: active, paused false, PAT present, ready=1\n.*ready: 1/s);
  });
});

describe('factories, status health and --factory', () => {
  const two = () => ({ defs: [defFixture('blocks'), defFixture('delta')], repos: [repoFixture('blocks', 'data'), repoFixture('delta', 'api')] });

  test('next --factory delta prints paused for a paused delta', async () => {
    const { store, out, go } = setup(two());
    await store.setSettings({ factories: { delta: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    const t = await store.createTask({ factoryId: 'delta', title: 'x', description: '', repo: 'api', status: 'ready' });
    expect(t.status).toBe('ready');
    expect(await go('next', '--factory', 'delta')).toBe(0);
    expect(out).toEqual(['paused']);
  });

  test('factories --json lists defs and repos and has no PAT value', async () => {
    const { out, go } = setup(two());
    expect(await go('factories', '--json')).toBe(0);
    const json = JSON.parse(out.join('\n'));
    expect(json.factories.map((f: { factoryId: string }) => f.factoryId)).toEqual(['blocks', 'delta']);
    expect(json.factories[1].repos).toMatchObject([{ repoId: 'api' }]);
    expect(out.join('\n')).not.toMatch(/secret/);
    expect(Object.keys(json.factories[0])).not.toContain('pat');
    await go('factories');
    expect(out.at(-1)).toBe('delta (delta) active: api');
  });

  test('new without --factory exits 1 with two active factories, and works with one', async () => {
    const two2 = setup(two());
    expect(await two2.go('new', '--repo', 'data', '--title', 'X', '--description', 'd')).toBe(1);
    expect(two2.err).toEqual(['error: --factory is required (active: blocks, delta)']);
    expect(await two2.store.listTasks()).toEqual([]);
    expect(await two2.go('new', '--factory', 'delta', '--repo', 'api', '--title', 'X', '--description', 'd')).toBe(0);
    expect(await two2.store.getTask('T-1')).toMatchObject({ factoryId: 'delta' });
    // An inactive factory does not count.
    const one = setup({ defs: [defFixture('blocks'), defFixture('delta', { active: false })], repos: two().repos });
    expect(await one.go('new', '--repo', 'data', '--title', 'X', '--description', 'd')).toBe(0);
    expect(await one.store.getTask('T-1')).toMatchObject({ factoryId: 'blocks' });
  });

  test('dev add needs --factory with two active factories', async () => {
    const { err, go } = setup(two());
    expect(await go('dev', 'add', '--repo', 'data', '--title', 'X')).toBe(1);
    expect(err).toEqual(['error: --factory is required (active: blocks, delta)']);
  });

  test('status writes a health row per factory and prints the PAT state', async () => {
    const { store, out, go } = setup(two(), ['github-pat:blocks']);
    expect(await go('status')).toBe(0);
    expect(out).toContain('factory blocks: active, paused false, PAT present');
    expect(out).toContain('factory delta: active, paused false, PAT missing');
    const health = await store.listFactoryHealth();
    expect(health.map((h) => [h.factoryId, h.patPresent])).toEqual([['blocks', true], ['delta', false]]);
    expect(JSON.stringify(health)).not.toMatch(/secret/);
  });

  test('status checks that each PAT entry exists without reading its value (M2)', async () => {
    const calls: string[][] = [];
    const { out, go } = setup(two(), ['github-pat:blocks'], calls);
    expect(await go('status')).toBe(0);
    expect(calls.length).toBe(2);
    expect(calls.some((a) => a.includes('-w'))).toBe(false);
    expect(out).toContain('factory blocks: active, paused false, PAT present');
    expect(out).toContain('factory delta: active, paused false, PAT missing');
  });

  test('status prints PAT unknown for a factory never checked (M2)', async () => {
    const { store, out, go } = setup(two());
    store.listFactoryDefs = async () => []; // nothing to probe: the health rows stay unwritten
    expect(await go('status')).toBe(0);
    expect(out).toContain('factory blocks: active, paused false, PAT unknown');
    expect(out).toContain('factory delta: active, paused false, PAT unknown');
  });

  test('a health write failure is logged and status still succeeds', async () => {
    const { store, out, err, go } = setup();
    store.setFactoryHealth = async () => { throw new Error('refused'); };
    expect(await go('status')).toBe(0);
    expect(err).toEqual(['health of blocks not written: refused']);
    expect(out[1]).toBe('factory blocks: active, paused false, PAT present');
  });

  test('status probes and records only the loaded, valid factories', async () => {
    const { store, go } = setup({ defs: [defFixture('blocks'), defFixture('bad', { name: '' })], repos: [] });
    expect(await go('status')).toBe(0);
    expect((await store.listFactoryHealth()).map((h) => h.factoryId)).toEqual(['blocks']);
  });

  test('status --factory limits the health check to the named factories', async () => {
    const { store, go } = setup(two());
    expect(await go('status', '--factory', 'delta')).toBe(0);
    expect((await store.listFactoryHealth()).map((h) => h.factoryId)).toEqual(['delta']);
  });
});

describe('migrate', () => {
  const rootWithRepos = () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-cli-migrate-'));
    cpSync(join(__dirname, '..', '..', 'repos'), join(root, 'repos'), { recursive: true });
    process.env.FACTORY_ROOT = root;
    return root;
  };
  afterEach(() => { delete process.env.FACTORY_ROOT; });

  test('needs --dry-run or --yes', async () => {
    const { err, go } = setup({ defs: [], repos: [] });
    expect(await go('migrate')).toBe(1);
    expect(err[0]).toMatch(/pass --check or --dry-run to preview, --yes to run/);
  });

  test('--yes runs the steps on the store and prints one line per step', async () => {
    rootWithRepos();
    const { store, out, err, go } = setup({ defs: [], repos: [] }, ['github-pat']);
    expect(await go('migrate', '--yes'), err.join()).toBe(0);
    expect(out.map((l) => l.split(':')[0])).toEqual(['create-factory', 'tag-tasks', 'move-settings', 'copy-pat', 'read-back', 'repos-folder']);
    expect((await store.listFactoryDefs()).map((d) => d.factoryId)).toEqual(['blocks']);
    out.length = 0;
    expect(await go('migrate', '--dry-run')).toBe(0);
    expect(out[0]).toBe('create-factory: already - factory blocks exists');
  });

  const blocksCli = (initial: string[]) => {
    const store = new BlocksStore(new FakeBlocksData('factory-core'), 'core');
    const out: string[] = [];
    const err: string[] = [];
    const exec = fakeSecurity(initial);
    const calls: string[][] = [];
    const spy: ExecFile = async (f, a, i) => { calls.push(a); return exec(f, a, i); };
    const go = (...argv: string[]) => run(['--store', 'blocks', ...argv], { out: (s) => out.push(s), err: (s) => err.push(s) }, async () => ({ engine: {} as Engine, store }), { exec: spy });
    return { store, out, err, go, calls };
  };

  test('on the Blocks store --yes runs only the Keychain copy and lists the pending owner steps', async () => {
    rootWithRepos();
    const { store, out, err, go, calls } = blocksCli(['github-pat']);
    expect(await go('migrate', '--yes')).toBe(0);
    expect(err).toEqual([]);
    expect(out.map((l) => l.split(':')[0])).toEqual(['copy-pat', 'create-factory', 'move-settings']);
    expect(out[0]).toMatch(/^copy-pat: now/);
    expect(out[1]).toBe('create-factory: pending - blocks factory not on the Board → import it on the Board (Settings → Factories → Import)');
    expect(calls.some((a) => a[0] === '-i')).toBe(true);
    expect(await store.listFactoryDefs()).toEqual([]);
  });

  test('--check is read-only: exit 2 while pending, 0 when done', async () => {
    rootWithRepos();
    const { out, go, calls } = blocksCli(['github-pat']);
    expect(await go('migrate', '--check')).toBe(2);
    expect(out[0]).toMatch(/^create-factory: pending/);
    expect(calls.some((a) => a[0] === '-i')).toBe(false);
    const done = setup({ defs: [defFixture('blocks')], repos: [] }, ['github-pat', 'github-pat:blocks']);
    // a Board import that holds the factory and every repo
    for (const r of buildImport(process.env.FACTORY_ROOT!, '/h').repos) await done.store.saveFactoryRepo(null, r);
    expect(await done.go('migrate', '--check')).toBe(0);
    expect(done.out.every((l) => !l.includes(': pending'))).toBe(true);
  });

  test('--export writes the import file and needs no store', async () => {
    const root = rootWithRepos();
    const file = join(root, 'import.json');
    const { go, wired } = setup();
    expect(await go('migrate', '--export', file)).toBe(0);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.format).toBe('factory-import/1');
    expect(json.factory.factoryId).toBe('blocks');
    expect(json.repos).toHaveLength(7);
    expect(wired).toHaveLength(0);
  });
});

describe('new', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'factory-new-'));

  test('creates an inbox task and prints the line; the event is core · new', async () => {
    const { store, out, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'Fix typo', '--description', 'd')).toBe(0);
    expect(out).toEqual(['T-1 created in inbox']);
    expect(await store.getTask('T-1')).toMatchObject({ title: 'Fix typo', description: 'd', repo: 'data', baseBranch: 'dev', status: 'inbox' });
    expect(await store.listEvents('T-1')).toMatchObject([{ actor: 'core · new', action: 'create', to: 'inbox', reason: 'created by factory new' }]);
  });

  test('--ready creates in ready; --base is used', async () => {
    const { store, out, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', '', '--ready', '--base', 'stg')).toBe(0);
    expect(out).toEqual(['T-1 created in ready']);
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', baseBranch: 'stg' });
  });

  test('--description-file reads the text as is', async () => {
    const { store, go } = setup();
    const file = join(dir(), 'd.md');
    writeFileSync(file, 'line one\n"quoted" $x `y`\n');
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description-file', file)).toBe(0);
    expect((await store.getTask('T-1')).description).toBe('line one\n"quoted" $x `y`\n');
  });

  test('--json prints the task', async () => {
    const { out, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', 'd', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ taskId: 'T-1', status: 'inbox' });
  });

  test('exactly one description source', async () => {
    const { store, err, go } = setup();
    const file = join(dir(), 'd.md');
    writeFileSync(file, 'x');
    expect(await go('new', '--repo', 'data', '--title', 'X')).toBe(1);
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', 'a', '--description-file', file)).toBe(1);
    expect(err).toEqual(Array(2).fill('error: pass exactly one of --description or --description-file'));
    expect(await store.listTasks()).toEqual([]);
  });

  test('a missing file, base main and an unknown repo exit 1 with one line', async () => {
    const { store, err, go } = setup();
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description-file', '/nope/none.md')).toBe(1);
    expect(await go('new', '--repo', 'data', '--title', 'X', '--description', 'd', '--base', 'main')).toBe(1);
    expect(await go('new', '--repo', 'ZZZ!', '--title', 'X', '--description', 'd')).toBe(1);
    expect(err[0]).toBe('error: cannot read --description-file /nope/none.md');
    expect(err[1]).toContain('the factory never targets main');
    expect(err[2]).toContain('--repo must be a repo id');
    expect(await store.listTasks()).toEqual([]);
  });

  test('works with a BlocksStore (core identity)', async () => {
    const storage = newFakeStorage();
    const data = new FakeBlocksData('factory-core', { storage });
    seedBlocksFactories(data, seed());
    const store = new BlocksStore(data, 'core');
    const out: string[] = [];
    const engine = new Engine({
      store, git, githubFor: () => new FakeGitHub(), factories: async () => new FactoryConfig(seed().defs, seed().repos),
      exec: async () => ({ code: 0, output: '' }), now: () => new Date(), mode: 'session', claimant: 'me',
    });
    const go = (...argv: string[]) => run(argv, { out: (s) => out.push(s), err: () => {} }, async () => ({ engine, store }));
    expect(await go('--store', 'blocks', 'new', '--repo', 'data', '--title', 'X', '--description', 'd', '--ready')).toBe(0);
    expect(out).toEqual(['T-1 created in ready']);
    expect(await store.listEvents('T-1')).toMatchObject([{ actor: 'core · new' }]);
  });
});
