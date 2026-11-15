import { describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { FileStore, ForbiddenError, MemoryStore, RereadAfterUpdateError, updateHeld, VersionConflictError } from '../src/store.js';
import { runStoreContract } from './storeContract.js';
import { emptyPushed, type GitHubLink } from '../src/githubLink.js';

const mk = (s: MemoryStore, title = 'a') => s.createTask({ factoryId: 'blocks', title, description: '', repo: 'data' });

runStoreContract('MemoryStore', (identity) => new MemoryStore({ identity }));
runStoreContract('FileStore', (identity) => new FileStore(join(mkdtempSync(join(tmpdir(), 'fs-contract-')), 'board.json'), { identity }));

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
    expect((await b.createTask({ factoryId: 'blocks', title: 'n', description: '', repo: 'os' })).taskId).toBe('T-2');
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
    await b.addEvents([{ taskId: 'T-1', factoryId: 'blocks', actor: 'you', action: 'move', field: 'status', from: 'inbox', to: 'cancelled', reason: 'c', at: 'now' }]);
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

describe('FileStore factories', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'fs-fac-'));

  test('seeds definitions from <root>/factories the first time, then keeps what the owner saves', async () => {
    const root = dir();
    mkdirSync(join(root, 'factories', 'delta', 'repos'), { recursive: true });
    writeFileSync(join(root, 'factories', 'delta', 'factory.yaml'), 'factoryId: delta\nname: Delta\n');
    writeFileSync(
      join(root, 'factories', 'delta', 'repos', 'api.yaml'),
      'repoId: api\nremote: git@github.com:o/api.git\nchecks:\n  server: { cwd: s, build: b, test: t }\n  client: { cwd: c, install: i, typecheck: tc, lint: l, test: t }\n  e2e: off\n',
    );
    // The board file is not in the root: the definitions dir is given explicitly.
    const board = join(root, '.factory', 'board.json');
    const opts = { factoriesDir: join(root, 'factories') };
    const s = new FileStore(board, opts);
    expect((await s.listFactoryDefs()).map((d) => d.factoryId)).toEqual(['delta']);
    expect((await s.listFactoryRepos('delta')).map((r) => r.repoId)).toEqual(['api']);
    const [def] = await s.listFactoryDefs();
    await s.saveFactoryDef(def!, { ...def!, name: 'Delta 2' });
    expect((await new FileStore(board, opts).listFactoryDefs())[0]).toMatchObject({ name: 'Delta 2', version: 2 });
  });

  test('an invalid definition is skipped with a logged reason; the valid one loads', async () => {
    const root = dir();
    for (const id of ['alpha', 'broken']) mkdirSync(join(root, 'factories', id), { recursive: true });
    writeFileSync(join(root, 'factories', 'alpha', 'factory.yaml'), 'factoryId: alpha\nname: Alpha\n');
    writeFileSync(join(root, 'factories', 'broken', 'factory.yaml'), 'factoryId: Not Valid\n');
    const lines: string[] = [];
    const s = new FileStore(join(root, 'board.json'), { factoriesDir: join(root, 'factories'), log: (l) => lines.push(l) });
    expect((await s.listFactoryDefs()).map((d) => d.factoryId)).toEqual(['alpha']);
    await s.listFactoryDefs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('broken');
  });

  test('the github block comes from factory.yaml on every load, also after the definitions were seeded', async () => {
    const root = dir();
    mkdirSync(join(root, 'factories', 'delta'), { recursive: true });
    const yaml = join(root, 'factories', 'delta', 'factory.yaml');
    const plain = 'factoryId: delta\nname: Delta\n';
    const github = 'github:\n  mode: github-only\n  project: kazi-lakit/3\n  statusMap:\n    inbox: Backlog\n    ready: Todo\n'
      + '    spec: In progress\n    spec_review: In progress\n    plan: In progress\n    plan_review: In progress\n    build: In progress\n'
      + '    verify: In progress\n    review: In progress\n    pr_open: In review\n    done: Done\n    blocked: In progress\n    cancelled: Done\n';
    writeFileSync(yaml, plain);
    const board = join(root, 'board.json');
    const opts = { factoriesDir: join(root, 'factories') };
    const s = new FileStore(board, opts);
    const [def] = await s.listFactoryDefs();
    await s.saveFactoryDef(def!, { ...def!, name: 'Delta 2' });

    writeFileSync(yaml, plain + github);
    const [withGh] = await new FileStore(board, opts).listFactoryDefs();
    expect(withGh).toMatchObject({ name: 'Delta 2', github: { mode: 'github-only', project: { owner: 'kazi-lakit', number: 3 }, label: 'factory' } });

    writeFileSync(yaml, plain);
    expect((await new FileStore(board, opts).listFactoryDefs())[0]).not.toHaveProperty('github');

    // A github hand-edited into board.json without YAML support is dropped.
    const raw = JSON.parse(readFileSync(board, 'utf8')) as { factoryDefs: Record<string, unknown>[] };
    raw.factoryDefs[0]!.github = withGh!.github;
    writeFileSync(board, JSON.stringify(raw));
    expect((await new FileStore(board, opts).listFactoryDefs())[0]).not.toHaveProperty('github');
  });

  test('a factory.yaml that fails validation is skipped and leaves the stored def without github', async () => {
    const root = dir();
    mkdirSync(join(root, 'factories', 'delta'), { recursive: true });
    const yaml = join(root, 'factories', 'delta', 'factory.yaml');
    writeFileSync(yaml, 'factoryId: delta\nname: Delta\n');
    const board = join(root, 'board.json');
    const opts = { factoriesDir: join(root, 'factories') };
    const [def] = await new FileStore(board, opts).listFactoryDefs();
    await new FileStore(board, opts).saveFactoryDef(def!, { ...def!, name: 'Delta 2' });
    const raw = JSON.parse(readFileSync(board, 'utf8')) as { factoryDefs: Record<string, unknown>[] };
    raw.factoryDefs[0]!.github = { mode: 'github-only' };
    writeFileSync(board, JSON.stringify(raw));
    writeFileSync(yaml, 'factoryId: delta\nname: Delta\ngithub:\n  mode: mirror\n');
    const lines: string[] = [];
    const defs = await new FileStore(board, { ...opts, log: (l) => lines.push(l) }).listFactoryDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ name: 'Delta 2' });
    expect(defs[0]).not.toHaveProperty('github');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('github.mode must be github-only or connected');
  });

  test('without factoriesDir nothing is seeded', async () => {
    const root = dir();
    mkdirSync(join(root, 'factories', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'factories', 'alpha', 'factory.yaml'), 'factoryId: alpha\n');
    expect(await new FileStore(join(root, 'board.json')).listFactoryDefs()).toEqual([]);
  });

  test('an old file without factories loads as factory blocks', async () => {
    const root = dir();
    const task = { taskId: 'T-1', title: 't', description: '', repo: 'data', baseBranch: 'dev', status: 'inbox', stage: null, branch: null, prUrl: null,
      attempt: 0, blockedReason: null, question: null, answer: null, gateOverrides: {}, claimBy: null, claimUntil: null, costUsd: 0, version: 1 };
    const event = { taskId: 'T-1', actor: 'you', action: 'create', field: null, from: null, to: 'inbox', reason: '', at: 't' };
    const legacy = { tasks: [task], docs: [], approvals: [], runs: [], events: [event],
      settings: { global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } };
    writeFileSync(join(root, 'board.json'), JSON.stringify(legacy));
    const s = new FileStore(join(root, 'board.json'));
    expect((await s.listTasks())[0]).toMatchObject({ taskId: 'T-1', factoryId: 'blocks', dependsOn: [] });
    expect((await s.listEvents('T-1'))[0]).toMatchObject({ factoryId: 'blocks' });
    expect(await s.getSettings()).toEqual({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } } });
    await s.updateSettingsScope('blocks/data', { maxParallel: 1 }, { maxParallel: 2 });
    expect((await new FileStore(join(root, 'board.json')).getSettings()).factories.blocks!.repos.data).toEqual({ maxParallel: 2 });
  });
});

const link = (taskId: string, factoryId: string): GitHubLink => ({
  taskId, factoryId, repo: 'o/r', issueNumber: null, issueNodeId: null, project: null, itemId: null,
  pushed: emptyPushed(), error: null, lease: null, reported: [], version: 0,
});

describe.each([
  ['MemoryStore', (identity?: 'core' | 'owner') => new MemoryStore({ identity })],
  ['FileStore', (identity?: 'core' | 'owner') => new FileStore(join(mkdtempSync(join(tmpdir(), 'fs-link-')), 'board.json'), { identity })],
])('%s GitHub links', (_name, make) => {
  test('saveGitHubLink inserts at version 1 and lists by factory', async () => {
    const s = make();
    const a = await s.saveGitHubLink(null, link('T-1', 'a'));
    await s.saveGitHubLink(null, link('T-2', 'b'));
    expect(a.version).toBe(1);
    expect(await s.listGitHubLinks('a')).toEqual([a]);
    expect(await s.listGitHubLinks()).toHaveLength(2);
    expect(await s.getGitHubLink('T-1')).toEqual(a);
    expect(await s.getGitHubLink('T-9')).toBeUndefined();
  });
  test('saveGitHubLink is compare-and-set', async () => {
    const s = make();
    const a = await s.saveGitHubLink(null, link('T-1', 'a'));
    const b = await s.saveGitHubLink(a, { ...a, issueNumber: 5 });
    expect(b.version).toBe(2);
    await expect(s.saveGitHubLink(a, { ...a, issueNumber: 6 })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(s.saveGitHubLink(null, link('T-1', 'a'))).rejects.toBeInstanceOf(VersionConflictError);
  });
  test('a stage 2 link loads with defaults', async () => {
    const s = make();
    const old = link('T-1', 'a');
    const { docAt: _d, blockedAt: _b, ...pushed } = old.pushed;
    const { reported: _r, ...rest } = old;
    await s.saveGitHubLink(null, { ...rest, pushed } as unknown as GitHubLink);
    const got = (await s.getGitHubLink('T-1'))!;
    expect(got.pushed.docAt).toEqual({ spec: null, plan: null });
    expect(got.pushed.blockedAt).toBeNull();
    expect(got.reported).toEqual([]);
    expect((await s.listGitHubLinks())[0]!.reported).toEqual([]);
  });
  test('owner identity may not save links', async () => {
    await expect(make('owner').saveGitHubLink(null, link('T-1', 'a'))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('FileStore GitHub links and factory.yaml', () => {
  test('a file without githubLinks loads', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fs-link-')), 'board.json');
    writeFileSync(path, '{"tasks":[]}');
    expect(await new FileStore(path).listGitHubLinks()).toEqual([]);
  });
  test('re-reads factory.yaml when it changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-yaml-'));
    mkdirSync(join(root, 'factories', 'a'), { recursive: true });
    const yaml = join(root, 'factories', 'a', 'factory.yaml');
    const text = (ready: string) => 'factoryId: a\nname: A\ngithub:\n  mode: github-only\n  project: kazi-lakit/3\n  statusMap:\n    inbox: Backlog\n'
      + `    ready: ${ready}\n    spec: In progress\n    spec_review: In progress\n    plan: In progress\n    plan_review: In progress\n    build: In progress\n`
      + '    verify: In progress\n    review: In progress\n    pr_open: In review\n    done: Done\n    blocked: In progress\n    cancelled: Done\n';
    writeFileSync(yaml, text('Todo'));
    const s = new FileStore(join(root, 'board.json'), { factoriesDir: join(root, 'factories') });
    expect((await s.listFactoryDefs())[0]!.github!.statusMap.ready).toBe('Todo');
    writeFileSync(yaml, text('Ready'));
    const later = new Date(Date.now() + 2000);
    utimesSync(yaml, later, later);
    expect((await s.listFactoryDefs())[0]!.github!.statusMap.ready).toBe('Ready');
  });
});

describe.each([
  ['MemoryStore', (identity?: 'core' | 'owner') => new MemoryStore({ identity })],
  ['FileStore', (identity?: 'core' | 'owner') => new FileStore(join(mkdtempSync(join(tmpdir(), 'fs-restore-')), 'board.json'), { identity })],
])('%s restoreTask', (_n, make) => {
  const task = (taskId: string) => ({
    taskId, factoryId: 'blocks', title: 't', description: 'd', repo: 'data', baseBranch: 'dev', status: 'blocked' as const, stage: null, branch: null,
    prUrl: null, attempt: 0, blockedReason: 'r', question: null, answer: null, gateOverrides: {}, dependsOn: [], claimBy: null, claimUntil: null, costUsd: 0, version: 7,
  });

  test('restoreTask keeps the id; a second restore conflicts; createTask continues after the highest id', async () => {
    const s = make('core');
    expect(await s.restoreTask(task('T-5'))).toMatchObject({ taskId: 'T-5', version: 1, status: 'blocked' });
    expect(await s.getTask('T-5')).toMatchObject({ version: 1 });
    await expect(s.restoreTask(task('T-5'))).rejects.toBeInstanceOf(VersionConflictError);
    expect((await s.createTask({ factoryId: 'blocks', title: 'n', description: '', repo: 'data' })).taskId).toBe('T-6');
  });

  test('restoreTask is core only', async () => {
    await expect(make('owner').restoreTask(task('T-1'))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
