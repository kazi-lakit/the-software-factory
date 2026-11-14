import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isProtected } from '../src/branches.js';
import { AGENT_MODELS, AGENT_STEPS, DEFAULT_GH_USER, FactoryConfig, ensureMain, validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from '../src/factories.js';
import { loadFactoriesFromDir } from '../src/factoriesFs.js';

const checks = {
  server: { cwd: 'server', build: 'b', test: 't' },
  client: { cwd: 'client', install: 'i', typecheck: 'tc', lint: 'l', test: 't' },
  e2e: 'off' as const,
};
const defInput = (over: Record<string, unknown> = {}) => ({ factoryId: 'delta', name: 'Delta', ...over });
const defOf = (id: string): FactoryDef => {
  const r = validateFactoryDef(defInput({ factoryId: id, name: id }));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const repoOf = (def: FactoryDef, repoId: string, remote: string): FactoryRepo => {
  const r = validateFactoryRepo({ repoId, remote, checks }, def);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('ensureMain', () => {
  test('adds main, dedupes and trims', () => {
    expect(ensureMain(['dev'])).toEqual(['dev', 'main']);
    expect(ensureMain(['main', 'main', ' dev '])).toEqual(['main', 'dev']);
  });
});

describe('validateFactoryDef', () => {
  test('the id global is reserved', () => {
    expect(validateFactoryDef(defInput({ factoryId: 'global' }))).toEqual({ ok: false, error: 'factory id global is reserved' });
  });

  test.each(['Delta', '1x', 'a'.repeat(41), 'a_b'])('rejects id %s', (id) => {
    expect(validateFactoryDef(defInput({ factoryId: id })).ok).toBe(false);
  });
  test('accepts delta, forces main, defaults the gh login', () => {
    const r = validateFactoryDef(defInput({ protectedBranches: ['dev'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.factoryId).toBe('delta');
    expect(r.value.protectedBranches).toEqual(['dev', 'main']);
    expect(r.value.ghUser).toBe('kazi-lakit');
    expect(r.value.active).toBe(true);
  });
  test('the default gh login is kazi-lakit', () => {
    expect(DEFAULT_GH_USER).toBe('kazi-lakit');
  });
  test.each(['', '   '])('an empty ghUser (%j) means the default (R16)', (ghUser) => {
    expect(validateFactoryDef(defInput({ ghUser }))).toMatchObject({ ok: true, value: { ghUser: 'kazi-lakit' } });
  });
  test.each(['octocat', ' Some-User ', 'a', 'a1-b2', 'x'.repeat(39)])('accepts the GitHub login %j, trimmed (R16)', (ghUser) => {
    expect(validateFactoryDef(defInput({ ghUser }))).toMatchObject({ ok: true, value: { ghUser: ghUser.trim() } });
  });
  test.each(['-lead', 'trail-', 'two--dashes', 'has space', 'under_score', 'x'.repeat(40), 'blocks-credential:x', 'keychain:delta'])(
    'refuses %j as ghUser (R16)',
    (ghUser) => {
      expect(validateFactoryDef(defInput({ ghUser }))).toEqual({ ok: false, error: 'ghUser must be a GitHub login' });
    },
  );
  test('a ghUser that is not text is refused', () => {
    expect(validateFactoryDef(defInput({ ghUser: 3 }))).toMatchObject({ ok: false });
  });
  test.each(['docs', './docs', '~/docs'])('a non-empty docsPath must be absolute (%j) (M5)', (docsPath) => {
    expect(validateFactoryDef(defInput({ docsPath }))).toEqual({ ok: false, error: 'docsPath must be an absolute folder or empty' });
  });
  test('docsPath may be empty or absolute (M5)', () => {
    expect(validateFactoryDef(defInput({ docsPath: '' })).ok).toBe(true);
    expect(validateFactoryDef(defInput({ docsPath: '/Users/me/docs' })).ok).toBe(true);
  });
  test('a non-empty gitEmail needs an @', () => {
    expect(validateFactoryDef(defInput({ gitEmail: 'nope' })).ok).toBe(false);
    expect(validateFactoryDef(defInput({ gitEmail: '' })).ok).toBe(true);
    expect(validateFactoryDef(defInput({ gitEmail: 'a@b.c' })).ok).toBe(true);
  });
  test('agentModels missing, null or empty leaves the field out', () => {
    for (const input of [defInput(), defInput({ agentModels: undefined }), defInput({ agentModels: null }), defInput({ agentModels: {} })]) {
      const r = validateFactoryDef(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect('agentModels' in r.value).toBe(false);
    }
  });
  test('accepts known stages mapped to known models', () => {
    const all = { spec: 'opus', plan: 'sonnet', build: 'haiku', verify: 'fable', review: 'opus' };
    expect(validateFactoryDef(defInput({ agentModels: all }))).toMatchObject({ ok: true, value: { agentModels: all } });
    const one = validateFactoryDef(defInput({ agentModels: { build: 'haiku' } }));
    expect(one.ok && one.value.agentModels).toEqual({ build: 'haiku' });
  });
  test.each(['x', 3, true, ['opus']])('refuses agentModels %j that is not a plain object', (agentModels) => {
    expect(validateFactoryDef(defInput({ agentModels }))).toEqual({ ok: false, error: 'agentModels must map stages to models' });
  });
  test.each(['check', 'ship', 'Spec', 'other'])('refuses the unknown stage %j', (stage) => {
    expect(validateFactoryDef(defInput({ agentModels: { [stage]: 'opus' } }))).toEqual({ ok: false, error: `agentModels has an unknown stage: ${stage}` });
  });
  test.each(['Opus', 'gpt', '', 3, null])('refuses the model %j', (model) => {
    expect(validateFactoryDef(defInput({ agentModels: { build: model } }))).toEqual({
      ok: false, error: 'agentModels.build must be one of opus, sonnet, haiku, fable',
    });
  });
  test('exports the stage and model lists', () => {
    expect(AGENT_STEPS).toEqual(['spec', 'plan', 'build', 'verify', 'review']);
    expect(AGENT_MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });
});

describe('validateFactoryDef github block', () => {
  const statusMap = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
    plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
    pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' };
  const block = (over = {}) => ({ mode: 'github-only', project: 'kazi-lakit/3', statusMap, ...over });
  test('a def without github has no github key', () => {
    const r = validateFactoryDef(defInput());
    expect(r.ok && 'github' in r.value).toBe(false);
  });
  test('a valid block is carried', () => {
    const r = validateFactoryDef(defInput({ github: block() }));
    expect(r).toMatchObject({ ok: true, value: { github: { mode: 'github-only', project: { owner: 'kazi-lakit', number: 3 }, approvers: ['kazi-lakit'] } } });
  });
  test('a bad block fails with its error', () => {
    expect(validateFactoryDef(defInput({ github: block({ mode: 'mirror' }) }))).toEqual({ ok: false, error: 'github.mode must be github-only or connected' });
  });
});

describe('validateFactoryRepo', () => {
  const def = defOf('delta');
  test.each(['main', 'refs/heads/main', 'origin/main', ' Main '])('main is never a base (%j)', (baseBranch) => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', baseBranch, checks }, def);
    expect(r).toEqual({ ok: false, error: 'main is never a base' });
  });
  test.each(['-uupload-pack=x', ' --upload-pack=x'])('refuses a remote that starts with - (%j) (M4)', (remote) => {
    expect(validateFactoryRepo({ repoId: 'api', remote, checks }, def)).toEqual({ ok: false, error: 'remote must not start with -' });
  });
  test.each([['/tmp', 'an absolute'], ['../x', 'a ..'], ['a/../../b', 'a ..'], ['a\\..\\b', 'a ..']])('refuses checks cwd %j (%s path) (M6)', (cwd) => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', checks: { ...checks, client: { ...checks.client, cwd } } }, def);
    expect(r).toEqual({ ok: false, error: 'checks.client.cwd must be a folder inside the repo (relative, no ..)' });
  });
  test.each(['.', 'client', 'apps/web', 'a..b'])('accepts checks cwd %j (M6)', (cwd) => {
    expect(validateFactoryRepo({ repoId: 'api', remote: 'r', checks: { ...checks, server: { ...checks.server, cwd } } }, def).ok).toBe(true);
  });
  test('rejects a bad repoId', () => {
    expect(validateFactoryRepo({ repoId: 'Api', remote: 'r', checks }, def).ok).toBe(false);
  });
  test('rejects malformed checks with the zod message', () => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', checks: { ...checks, e2e: 'on' } }, def);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/checks/);
  });
  test('accepts base dev, carrying the factory id', () => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', baseBranch: 'dev', checks }, def);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ factoryId: 'delta', repoId: 'api', baseBranch: 'dev' });
  });
});

describe('FactoryConfig', () => {
  test('two factories can both have repo api', () => {
    const delta = defOf('delta');
    const mods = defOf('mods');
    const cfg = new FactoryConfig([delta, mods], [repoOf(delta, 'api', 'git@x:delta/api.git'), repoOf(mods, 'api', 'git@x:mods/api.git')]);
    expect(cfg.factories().map((f) => f.factoryId)).toEqual(['delta', 'mods']);
    expect(cfg.repo('delta', 'api')!.remote).not.toBe(cfg.repo('mods', 'api')!.remote);
    expect(cfg.repos('mods')).toHaveLength(1);
    expect(cfg.factory('nope')).toBeUndefined();
  });
  test('an invalid def is skipped and listed', () => {
    const good = defOf('delta');
    const bad = { ...good, factoryId: 'Bad' };
    const cfg = new FactoryConfig([good, bad], [repoOf(good, 'api', 'r')]);
    expect(cfg.factories().map((f) => f.factoryId)).toEqual(['delta']);
    expect(cfg.skipped()).toEqual([{ id: 'Bad', reason: expect.any(String) }]);
  });
});

describe('isProtected with a factory list', () => {
  test('uses the given list; main always counts', () => {
    expect(isProtected('origin/main', ['dev'])).toBe(true);
    expect(isProtected('rel', ['rel'])).toBe(true);
    expect(isProtected('feature', ['dev'])).toBe(false);
  });
});

describe('loadFactoriesFromDir', () => {
  test('reads factory.yaml and repos/*.yaml per factory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    const yamlChecks = `checks:
  server: { cwd: server, build: b, test: t }
  client: { cwd: client, install: i, typecheck: tc, lint: l, test: t }
  e2e: off
`;
    for (const id of ['delta', 'mods']) {
      mkdirSync(join(dir, id, 'repos'), { recursive: true });
      writeFileSync(join(dir, id, 'factory.yaml'), `factoryId: ${id}\nname: ${id}\nprotectedBranches: [dev]\n`);
      writeFileSync(join(dir, id, 'repos', 'api.yaml'), `repoId: api\nremote: git@x:${id}/api.git\n${yamlChecks}`);
    }
    const { defs, repos } = loadFactoriesFromDir(dir);
    expect(defs.map((d) => d.factoryId).sort()).toEqual(['delta', 'mods']);
    expect(defs[0]!.protectedBranches).toEqual(['dev', 'main']);
    expect(repos.map((r) => `${r.factoryId}/${r.repoId}`).sort()).toEqual(['delta/api', 'mods/api']);
    expect(repos[0]!.baseBranch).toBe('dev');
  });
  test('a missing directory is empty', () => {
    expect(loadFactoriesFromDir(join(tmpdir(), 'no-such-factories-dir'))).toEqual({ defs: [], repos: [] });
  });
});
