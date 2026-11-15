import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_STATUS_MAP, STANDARD_STATUS_MAP, validateGitHubSettings } from '../src/githubConfig.js';
import { normaliseFactoryYaml, type FactoryYaml } from '../src/factoryYaml.js';
import { ALL_STATUSES } from '../src/status.js';

// Checks stay in today's object shape until the checks list lands (a later task).
const CHECKS = {
  server: { cwd: 'server', build: 'b', test: 't' },
  client: { cwd: 'client', install: 'i', typecheck: 'tc', lint: 'l', test: 't' },
  e2e: 'off',
};

/** The design's section 5 example, with baseBranch dev and statusMap left out. */
const NEW_EXAMPLE = `
factory:
  id: myapp
  name: My App
  source: local
  docsPath: ""
  git: { name: "", email: "" }
  active: true
  agents:
    spec: opus
    plan: opus
    build: sonnet
    verify: haiku
    review: opus

accounts:
  github: my-login

board:
  source: github
  mirror: none
  project: my-login/7
  label: factory
  approvers: [my-login, teammate]

gates: { spec: true, plan: false, pr: true }

repos:
  host: github
  protectedBranches: [dev, stg, main]
  list:
    - id: web
      remote: git@github.com:my-org/web.git
      host: github
      baseBranch: dev
      protectedBranches: [main]
      checks:
        server: { cwd: server, build: b, test: t }
        client: { cwd: client, install: i, typecheck: tc, lint: l, test: t }
        e2e: "off"
`;

const REPO = { id: 'web', remote: 'git@github.com:my-org/web.git', baseBranch: 'dev', checks: CHECKS };
const BASE = {
  factory: { id: 'myapp', name: 'My App', source: 'local' },
  accounts: { github: 'my-login' },
  board: { source: 'github', project: 'my-login/7' },
  repos: { list: [REPO] },
};
const SAME_INBOX_READY = { ...DEFAULT_STATUS_MAP, ready: DEFAULT_STATUS_MAP.inbox };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Deep merge: objects merge, everything else (lists included) replaces; an empty object clears the section. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch) || Object.keys(patch).length === 0) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}
const ok = (raw: unknown): FactoryYaml => {
  const r = normaliseFactoryYaml(raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('normaliseFactoryYaml: new shape', () => {
  test('new shape maps to the internal def and repos', () => {
    const r = normaliseFactoryYaml(parse(NEW_EXAMPLE));
    expect(r.ok && r.value.def).toMatchObject({
      factoryId: 'myapp', name: 'My App', ghUser: 'my-login', protectedBranches: ['dev', 'stg', 'main'],
      agentModels: { spec: 'opus', build: 'sonnet', verify: 'haiku' },
      github: { mode: 'github-only', project: { owner: 'my-login', number: 7 }, statusMap: DEFAULT_STATUS_MAP },
    });
    expect(r.ok && r.value.repos[0]).toMatchObject({ repoId: 'web', baseBranch: 'dev', protectedBranches: ['main'] });
  });

  test('the rest of the new shape: source, board, accounts, versions', () => {
    const v = ok(parse(NEW_EXAMPLE));
    expect(v.shape).toBe('new');
    expect(v.source).toBe('local');
    expect(v.accounts).toEqual({ github: 'my-login' });
    expect(v.board).toEqual({
      source: 'github', mirror: 'none', project: { owner: 'my-login', number: 7 }, label: 'factory',
      approvers: ['my-login', 'teammate'], statusMap: DEFAULT_STATUS_MAP,
    });
    expect(v.def.version).toBe(0);
    expect(v.repos[0]!.version).toBe(0);
    expect(v.repos[0]!.factoryId).toBe('myapp');
  });

  test('factory-app with a GitHub mirror is connected mode', () => {
    const v = ok(merge(BASE, { factory: { source: 'factory-app' }, board: { source: 'factory-app', mirror: 'github' } }));
    expect(v.source).toBe('factory-app');
    expect(v.board).toMatchObject({ source: 'factory-app', mirror: 'github', project: { owner: 'my-login', number: 7 } });
    expect(v.def.github).toMatchObject({ mode: 'connected' });
  });

  test('factory-app with no mirror has no github block', () => {
    const v = ok(merge(BASE, { factory: { source: 'factory-app' }, board: { source: 'factory-app' } }));
    expect(v.def.github).toBeUndefined();
    expect(v.board).toMatchObject({ source: 'factory-app', mirror: 'none', project: null });
  });

  test('with no board and no repos, no account is needed and ghUser falls back as today', () => {
    const v = ok({ factory: { id: 'solo' } });
    expect(v.board).toMatchObject({ source: 'none', mirror: 'none', project: null });
    expect(v.def.github).toBeUndefined();
    expect(v.def.ghUser).toBe('kazi-lakit');
    expect(v.accounts).toEqual({});
    expect(v.def.protectedBranches).toEqual(['dev', 'stg', 'main']);
    expect(v.gates).toBeNull();
  });

  test.each([
    [{ board: { source: 'trello' } }, 'board.source: trello is not supported yet'],
    [{ board: { source: 'jira' } }, 'board.source: jira is not supported yet'],
    [{ board: { source: 'factory-app' } }, 'board.source: factory-app needs factory.source factory-app'],
    [{ board: { source: 'github', mirror: 'github', project: 'a/1' } }, 'board.mirror: github needs board.source factory-app'],
    [{ factory: { source: 'factory-app' } }, 'board.source: github needs factory.source local'],
    [{ factory: { source: 'factory-app' }, board: { source: 'none' } }, 'board.source: must be factory-app when factory.source is factory-app (the app is its board)'],
    [{ accounts: {} }, 'accounts.github is required (used by: board, repos)'],
    [{ repos: { host: 'gitlab' } }, 'repos.host: gitlab is not supported yet'],
    [{ repos: { list: [{ ...REPO, host: 'gitlab' }] } }, 'repos.list[0].host: gitlab is not supported yet'],
    [{ factory: { agents: { build: 'gpt' } } }, 'factory.agents.build: must be one of opus, sonnet, haiku, fable'],
    [{ repos: { list: [{ ...REPO, baseBranch: 'main' }] } }, 'repos.list[0].baseBranch: main is never a base'],
    [{ repos: { list: [REPO, REPO] } }, 'repos.list[1].id: duplicate repo id web'],
    [{ board: { statusMap: SAME_INBOX_READY } }, 'board.statusMap: inbox and ready must map to different options'],
    [{ board: { project: 'nope' } }, 'board.project: must be owner/number'],
    [{ factory: { id: 'Bad' } }, 'factory.id: must match ^[a-z][a-z0-9-]*$ and be at most 40 characters'],
    [{ factory: { git: { email: 'x' } } }, 'factory.git.email: must contain @'],
    [{ accounts: { github: 'no spaces' } }, 'accounts.github: must be a GitHub login'],
    [{ repos: { list: [{ ...REPO, remote: '' }] } }, 'repos.list[0].remote: must not be blank'],
    [{ gates: { spec: 'yes' } }, 'gates.spec: must be true or false'],
  ])('refuses %j', (patch, error) => expect(normaliseFactoryYaml(merge(BASE, patch))).toEqual({ ok: false, error }));

  test('a factory-app factory with no board section is refused too', () => {
    expect(normaliseFactoryYaml({ factory: { id: 'app', source: 'factory-app' } }))
      .toEqual({ ok: false, error: 'board.source: must be factory-app when factory.source is factory-app (the app is its board)' });
  });

  test('a blank host counts as left out', () => {
    const v = ok(merge(BASE, { repos: { host: '', list: [{ ...REPO, host: '  ' }] } }));
    expect(v.repos.map((r) => r.repoId)).toEqual(['web']);
  });

  test('a board-only GitHub use names only the board', () => {
    expect(normaliseFactoryYaml(merge(BASE, { accounts: {}, repos: { list: [] } }))).toEqual({ ok: false, error: 'accounts.github is required (used by: board)' });
  });

  test('gates are read in local mode and ignored for factory-app', () => {
    expect(ok(merge(BASE, { gates: { spec: true, plan: false } })).gates).toEqual({ spec: true, plan: false });
    expect(ok(merge(BASE, { factory: { source: 'factory-app' }, board: { source: 'factory-app' }, gates: { spec: true, plan: false } })).gates).toBeNull();
  });

  test('a per-repo protectedBranches override gets main added; the factory default applies otherwise', () => {
    const v = ok(merge(BASE, { repos: { list: [{ ...REPO, protectedBranches: ['release'] }, { ...REPO, id: 'api' }] } }));
    expect(v.repos[0]!.protectedBranches).toEqual(['release', 'main']);
    expect(v.repos[1]!.protectedBranches).toBeUndefined();
    expect(v.def.protectedBranches).toEqual(['dev', 'stg', 'main']);
  });
});

describe('normaliseFactoryYaml: legacy shape', () => {
  const LEGACY = {
    factoryId: 'old', name: 'Old', ghUser: 'old-login', gitName: 'Bot', gitEmail: 'bot@example.com', docsPath: '/docs',
    protectedBranches: ['dev', 'rel'], agentModels: { build: 'sonnet' }, active: false, version: 4,
  };

  test('every legacy field maps', () => {
    const v = ok({ ...LEGACY, github: { mode: 'github-only', project: 'old-login/3', approvers: ['old-login'], statusMap: DEFAULT_STATUS_MAP } });
    expect(v.shape).toBe('legacy');
    expect(v.accounts).toEqual({ github: 'old-login' });
    expect(v.def).toMatchObject({
      factoryId: 'old', name: 'Old', ghUser: 'old-login', gitName: 'Bot', gitEmail: 'bot@example.com', docsPath: '/docs',
      protectedBranches: ['dev', 'rel', 'main'], agentModels: { build: 'sonnet' }, active: false, version: 0,
    });
    expect(v.source).toBe('local');
    expect(v.board).toEqual({
      source: 'github', mirror: 'none', project: { owner: 'old-login', number: 3 }, label: 'factory', approvers: ['old-login'], statusMap: DEFAULT_STATUS_MAP,
    });
    expect(v.repos).toEqual([]);
    expect(v.gates).toBeNull();

    const c = ok({ ...LEGACY, github: { mode: 'connected', project: 'old-login/3', statusMap: DEFAULT_STATUS_MAP } });
    expect(c.source).toBe('factory-app');
    expect(c.board).toMatchObject({ source: 'factory-app', mirror: 'github', project: { owner: 'old-login', number: 3 } });
    expect(c.def.github).toMatchObject({ mode: 'connected' });
  });

  test('a legacy github block with no ghUser still records the github account it resolves to', () => {
    const { ghUser: _, ...noUser } = LEGACY;
    const v = ok({ ...noUser, github: { mode: 'github-only', project: 'kazi-lakit/3', statusMap: DEFAULT_STATUS_MAP } });
    expect(v.def.ghUser).toBe('kazi-lakit');
    expect(v.accounts).toEqual({ github: 'kazi-lakit' });
    expect(ok(noUser).accounts).toEqual({});
  });

  test('a legacy file with no github block is local with board none', () => {
    const v = ok(LEGACY);
    expect(v.source).toBe('local');
    expect(v.board.source).toBe('none');
    expect(v.def.github).toBeUndefined();
  });

  test('legacy errors read as today', () => {
    expect(normaliseFactoryYaml({ ...LEGACY, gitEmail: 'x' })).toEqual({ ok: false, error: 'gitEmail must contain @' });
  });
});

test('STANDARD_STATUS_MAP passes the status map rules', () => {
  expect(validateGitHubSettings({ mode: 'github-only', project: 'o/1', statusMap: STANDARD_STATUS_MAP }, 'o').ok).toBe(true);
  expect(ALL_STATUSES.map((s) => STANDARD_STATUS_MAP[s])).toEqual([
    'Inbox', 'Ready', 'Spec', 'Spec review', 'Plan', 'Plan review', 'Build', 'Verify', 'Review', 'PR open', 'Done', 'Blocked', 'Cancelled',
  ]);
});
