import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { buildImport, checkMigration, migrate, type MigrateReport } from '../src/migrate.js';
import { validateImportFile } from '../src/importFile.js';
import type { ExecFile } from '../src/secrets.js';
import { FileStore, MemoryStore, type BoardStore } from '../src/store.js';

const REPOS = join(__dirname, 'fixtures', 'repos');

/** A Memory store holding the pre-factories shape: untagged tasks and `{ global, repos }` settings. */
class LegacyMemory extends MemoryStore {
  seedLegacy(): void {
    this.state.tasks.push({ taskId: 'T-1', title: 't', description: '', repo: 'data', baseBranch: 'dev', status: 'inbox', version: 1 } as never);
    this.state.settings = { global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } as never;
  }
}

/** A fake `gh`: `auth status --json hosts` lists `logins` in state success on github.com. Anything else (the Keychain, `gh auth token`) throws. */
function fakeGh(logins: string[] = ['kazi-lakit'], answer?: { code: number; stdout: string }) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: ExecFile = async (file, args) => {
    calls.push({ file, args });
    if (file !== 'gh' || args.join(' ') !== 'auth status --hostname github.com --json hosts') throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    return answer ? { ...answer, stderr: '' } : { code: 0, stdout: JSON.stringify({ hosts: { 'github.com': logins.map((login) => ({ login, state: 'success' })) } }), stderr: '' };
  };
  return { exec, calls };
}

const names = (r: MigrateReport) => r.steps.map((s) => `${s.name}:${s.done}`);
const ALL_NOW = ['create-factory:now', 'tag-tasks:now', 'move-settings:now', 'gh-login:already', 'read-back:now', 'repos-folder:now'];
const ALL_ALREADY = ['create-factory:already', 'tag-tasks:already', 'move-settings:already', 'gh-login:already', 'read-back:already', 'repos-folder:already'];

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-migrate-'));
  home = join(root, 'home');
  cpSync(REPOS, join(root, 'repos'), { recursive: true });
});

const kinds: [string, () => BoardStore][] = [
  ['memory', () => { const s = new LegacyMemory(); s.seedLegacy(); return s; }],
  ['file', () => {
    const dir = join(root, '.factory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.json'), JSON.stringify({
      tasks: [{ taskId: 'T-1', title: 't', description: '', repo: 'data', baseBranch: 'dev', status: 'inbox', version: 1 }],
      events: [{ taskId: 'T-1', actor: 'you', action: 'create', field: null, from: null, to: 'inbox', reason: '', at: '2026-01-01T00:00:00.000Z' }],
      settings: { global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } },
    }));
    return new FileStore(join(dir, 'board.json'));
  }],
];

describe.each(kinds)('migrate on a %s store', (_name, make) => {
  test('a fresh migrate runs every step now, a second run is all already', async () => {
    const store = make();
    const kc = fakeGh();
    const first = await migrate(store, root, home, kc.exec);
    expect(names(first)).toEqual(ALL_NOW);
    const def = (await store.listFactoryDefs())[0]!;
    expect(def).toMatchObject({
      factoryId: 'blocks', name: 'Blocks', protectedBranches: ['dev', 'stg', 'main'], ghUser: 'kazi-lakit',
      docsPath: join(home, 'scratchpad', 'selise', 'vaultS', 'projects'),
    });
    expect((await store.listFactoryRepos('blocks')).map((r) => r.repoId)).toEqual(['data', 'iam', 'localization', 'logic', 'monitor', 'os', 'release']);
    expect((await store.getTask('T-1')).factoryId).toBe('blocks');
    expect((await store.getSettings()).factories.blocks).toEqual({ factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } });
    expect(names(await migrate(store, root, home, kc.exec))).toEqual(ALL_ALREADY);
  });

  test('gh-login only reads gh auth status: no Keychain, no gh auth token (R16)', async () => {
    const kc = fakeGh();
    const report = await migrate(make(), root, home, kc.exec);
    expect(report.steps.find((s) => s.name === 'gh-login')).toEqual({ name: 'gh-login', done: 'already', detail: 'gh account kazi-lakit is logged in' });
    expect(kc.calls).toEqual([{ file: 'gh', args: ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'] }]);
  });

  test('a gh login that is not there is pending and stops nothing (R16)', async () => {
    const store = make();
    const report = await migrate(store, root, home, fakeGh(['someone-else']).exec);
    expect(names(report)).toEqual(['create-factory:now', 'tag-tasks:now', 'move-settings:now', 'gh-login:pending', 'read-back:now', 'repos-folder:now']);
    expect(report.steps[3]!.detail).toBe('gh account kazi-lakit is not logged in: run gh auth login');
    expect(await store.listFactoryDefs()).toHaveLength(1);
  });

  test('a failure at step 3, then a re-run, completes', async () => {
    const store = make();
    const real = store.setSettings.bind(store);
    let fail = true;
    store.setSettings = async (s) => {
      if (fail) { fail = false; throw new Error('write refused'); }
      return real(s);
    };
    const kc = fakeGh();
    const seen: string[] = [];
    await expect(migrate(store, root, home, kc.exec, { onStep: (s) => seen.push(s.name) })).rejects.toThrow('write refused');
    expect(seen).toEqual(['create-factory', 'tag-tasks']);
    const again = await migrate(store, root, home, kc.exec);
    expect(again.steps.map((s) => s.done)).not.toContain('skipped');
    expect(again.steps[0]!.done).toBe('already');
    expect((await store.getSettings()).factories.blocks).toEqual({ factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } });
    expect(names(await migrate(store, root, home, kc.exec))).toEqual(ALL_ALREADY);
  });

  test('a failure in step 1 after some repos leaves no factory, and the re-run resumes', async () => {
    const store = make();
    const real = store.saveFactoryRepo.bind(store);
    let n = 0;
    store.saveFactoryRepo = async (b, a) => {
      if (++n === 3) throw new Error('boom');
      return real(b, a);
    };
    const kc = fakeGh();
    await expect(migrate(store, root, home, kc.exec)).rejects.toThrow('boom');
    expect(await store.listFactoryDefs()).toEqual([]);
    await migrate(store, root, home, kc.exec);
    expect((await store.listFactoryRepos('blocks'))).toHaveLength(7);
    expect(await store.listFactoryDefs()).toHaveLength(1);
  });

  test('--dry-run writes nothing and says what it would do', async () => {
    const store = make();
    const kc = fakeGh();
    const report = await migrate(store, root, home, kc.exec, { dryRun: true });
    expect(names(report)).toEqual(['create-factory:now', 'tag-tasks:now', 'move-settings:now', 'gh-login:already', 'read-back:skipped', 'repos-folder:now']);
    expect(report.steps[0]!.detail).toMatch(/^would create blocks/);
    expect(await store.listFactoryDefs()).toEqual([]);
  });

  test('old-layout clones are reported as a note and not moved', async () => {
    mkdirSync(join(root, '.clones', 'os', '.git'), { recursive: true });
    mkdirSync(join(root, '.clones', 'blocks', 'data', '.git'), { recursive: true });
    mkdirSync(join(root, '.clones', 'worktrees', 'T-1'), { recursive: true });
    const report = await migrate(make(), root, home, fakeGh().exec);
    expect(report.notes).toEqual([expect.stringContaining('.clones/os')]);
    expect(report.notes[0]).not.toContain('.clones/blocks');
    expect(existsSync(join(root, '.clones', 'os', '.git'))).toBe(true);
  });
});

test('step 3 includes the retire result of the store', async () => {
  const store = new LegacyMemory();
  store.seedLegacy();
  store.retireLegacySettings = async () => ({ retired: ['data', 'global'], remaining: ['os'] });
  const report = await migrate(store, root, home, fakeGh().exec);
  expect(report.steps[2]!.detail).toContain('retired legacy rows: data, global');
  expect(report.notes).toContain('legacy settings rows not retired: os');
});

test('a read-back mismatch stops before step 6', async () => {
  const store = new LegacyMemory();
  store.seedLegacy();
  const real = store.listFactoryRepos.bind(store);
  store.listFactoryRepos = async (f) => (await real(f)).slice(1);
  const seen: string[] = [];
  await expect(migrate(store, root, home, fakeGh().exec, { onStep: (s) => seen.push(s.name) })).rejects.toThrow(/read-back failed: repo data is missing/);
  expect(seen).not.toContain('repos-folder');
});

describe('buildImport and validateImportFile', () => {
  test('buildImport reads repos/*.yaml with the migrate defaults and holds no secret', () => {
    const file = buildImport(root, home);
    expect(file.format).toBe('factory-import/1');
    expect(file.factory).toMatchObject({ factoryId: 'blocks', name: 'Blocks', protectedBranches: ['dev', 'stg', 'main'], ghUser: 'kazi-lakit' });
    expect(file.repos.map((r) => r.repoId)).toEqual(['data', 'iam', 'localization', 'logic', 'monitor', 'os', 'release']);
    expect(validateImportFile(JSON.parse(JSON.stringify(file)))).toEqual({ ok: true, value: file });
    expect(JSON.stringify(file)).not.toMatch(/ghp_|token/i);
  });

  test('validateImportFile rejects a bad format, fixes a missing main, and rejects a bad repo', () => {
    const good = buildImport(root, home);
    expect(validateImportFile({ ...good, format: 'x/2' })).toEqual({ ok: false, error: 'format must be factory-import/1' });
    expect(validateImportFile(null)).toMatchObject({ ok: false });
    const noMain = validateImportFile({ ...good, factory: { ...good.factory, protectedBranches: ['dev'] } });
    expect(noMain.ok && noMain.value.factory.protectedBranches).toEqual(['dev', 'main']);
    const bad = validateImportFile({ ...good, repos: [{ ...good.repos[0], baseBranch: 'main' }] });
    expect(bad).toEqual({ ok: false, error: 'repos[0]: main is never a base' });
    expect(validateImportFile({ ...good, repos: [good.repos[0], good.repos[0]] })).toMatchObject({ ok: false });
    expect(validateImportFile({ ...good, factory: { ...good.factory, factoryId: 'Bad Id' } })).toMatchObject({ ok: false });
  });
});

test('checkMigration is read-only and reports pending then done', async () => {
  const store = new LegacyMemory();
  store.seedLegacy();
  const kc = fakeGh([]);
  const before = await checkMigration(store, root, home, kc.exec);
  expect(names(before)).toEqual(['create-factory:pending', 'tag-tasks:pending', 'move-settings:pending', 'gh-login:pending']);
  expect(before.steps[3]!.detail).toBe('gh account kazi-lakit is not logged in: run gh auth login');
  expect(await store.listFactoryDefs()).toEqual([]);
  await migrate(store, root, home, kc.exec);
  const after = await checkMigration(store, root, home, fakeGh(['Kazi-Lakit']).exec);
  expect(names(after)).toEqual(['create-factory:already', 'tag-tasks:already', 'move-settings:already', 'gh-login:already']);
  expect(after.steps[3]!.detail).toBe('gh account kazi-lakit is logged in');
});

test('checkMigration: a gh that fails or prints no JSON is pending, and the stored blocks login is the one checked (R16)', async () => {
  for (const answer of [{ code: 1, stdout: '' }, { code: 0, stdout: 'nope' }]) {
    const check = await checkMigration(new MemoryStore(), root, home, fakeGh([], answer).exec, { blocks: true });
    expect(check.steps.find((s) => s.name === 'gh-login')).toMatchObject({ done: 'pending' });
  }
  const store = new MemoryStore();
  const imp = buildImport(root, home);
  await store.saveFactoryDef(null, { ...imp.factory, ghUser: 'octocat' });
  const check = await checkMigration(store, root, home, fakeGh(['octocat']).exec, { blocks: true });
  expect(check.steps.find((s) => s.name === 'gh-login')).toEqual({ name: 'gh-login', done: 'already', detail: 'gh account octocat is logged in' });
});

describe('R10 fix round', () => {
  test('check: a partial Board import (missing or different repos) is pending, not done', async () => {
    const store = new MemoryStore();
    const imp = buildImport(root, home);
    await store.saveFactoryDef(null, imp.factory);
    for (const r of imp.repos.slice(2)) await store.saveFactoryRepo(null, r);
    const kc = fakeGh();
    const miss = (await checkMigration(store, root, home, kc.exec, { blocks: true })).steps[0]!;
    expect(miss.done).toBe('pending');
    expect(miss.detail).toContain('missing: data, iam');
    for (const r of imp.repos.slice(0, 2)) await store.saveFactoryRepo(null, r);
    expect((await checkMigration(store, root, home, kc.exec, { blocks: true })).steps[0]!.done).toBe('already');
    const stored = (await store.listFactoryRepos('blocks')).find((r) => r.repoId === 'data')!;
    await store.saveFactoryRepo(stored, { ...stored, remote: 'git@example.com:x/y.git' });
    const diff = (await checkMigration(store, root, home, kc.exec, { blocks: true })).steps[0]!;
    expect(diff).toMatchObject({ done: 'pending' });
    expect(diff.detail).toContain('different from repos/*.yaml: data');
  });

  test('old-layout clones appear as a note in check, not as a step', async () => {
    mkdirSync(join(root, '.clones', 'os', '.git'), { recursive: true });
    const check = await checkMigration(new MemoryStore(), root, home, fakeGh().exec, { blocks: true });
    expect(check.notes).toEqual([expect.stringContaining('.clones/os')]);
    expect(check.steps.map((s) => s.name)).not.toContain('old-layout');
  });

  test('a stray board.json does not keep Blocks pending, and Blocks has no tag-tasks step', async () => {
    kinds[1]![1](); // writes a legacy board.json under root
    const kc = fakeGh();
    const store = new MemoryStore();
    const imp = buildImport(root, home);
    for (const r of imp.repos) await store.saveFactoryRepo(null, r);
    await store.saveFactoryDef(null, imp.factory);
    const check = await checkMigration(store, root, home, kc.exec, { blocks: true });
    expect(check.steps.map((s) => s.name)).toEqual(['create-factory', 'move-settings', 'gh-login']);
    expect(check.steps.every((s) => s.done !== 'pending')).toBe(true);
  });

  test('a file store counts the untagged tasks from the raw file', async () => {
    const store = kinds[1]![1]();
    const check = await checkMigration(store, root, home, fakeGh().exec);
    expect(check.steps.find((s) => s.name === 'tag-tasks')).toMatchObject({ done: 'pending', detail: '1 tasks without a factory' });
    const report = await migrate(store, root, home, fakeGh().exec, { dryRun: true });
    expect(report.steps[1]!.detail).toContain('tag 1 tasks');
  });
});
