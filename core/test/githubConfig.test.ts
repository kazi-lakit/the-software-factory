import { describe, expect, test } from 'vitest';
import { validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from '../src/factories.js';
import { githubConfigProblems, validateGitHubSettings } from '../src/githubConfig.js';

const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
  plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
  pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' };
const input = (over = {}) => ({ mode: 'github-only', project: 'kazi-lakit/3', statusMap: map, ...over });

test('absent or null is no GitHub', () => {
  expect(validateGitHubSettings(undefined, 'kazi-lakit')).toEqual({ ok: true, value: undefined });
  expect(validateGitHubSettings(null, 'kazi-lakit')).toEqual({ ok: true, value: undefined });
});
test('defaults label and approvers', () => {
  const r = validateGitHubSettings(input(), 'kazi-lakit');
  expect(r).toEqual({ ok: true, value: { mode: 'github-only', project: { owner: 'kazi-lakit', number: 3 }, label: 'factory', approvers: ['kazi-lakit'], statusMap: map } });
});
test('empty label is kept as no filter', () => {
  expect(validateGitHubSettings(input({ label: '' }), 'u')).toMatchObject({ ok: true, value: { label: '' } });
});
test('{} needs a mode', () => {
  expect(validateGitHubSettings({}, 'u')).toEqual({ ok: false, error: 'github.mode is required' });
});
test.each([
  [{ mode: 'mirror' }, 'github.mode must be github-only or connected'],
  [{ project: 'kazi-lakit' }, 'github.project must be owner/number'],
  [{ project: 'kazi-lakit/0' }, 'github.project must be owner/number'],
  [{ approvers: [] }, 'github.approvers must list at least one GitHub login'],
  [{ approvers: ['not a login'] }, 'github.approvers must list at least one GitHub login'],
  [{ statusMap: { ...map, testing: 'Testing' } }, 'github.statusMap has an unknown status: testing'],
  [{ statusMap: { ...map, verify: undefined } }, 'github.statusMap.verify is required'],
  [{ statusMap: { ...map, verify: '  ' } }, 'github.statusMap.verify must not be blank'],
  [{ statusMap: { ...map, ready: 'Backlog' } }, 'github.statusMap: inbox and ready must map to different options'],
  [{ statusMap: { ...map, blocked: 'Todo' } }, 'github.statusMap.blocked must not share the ready option (only done and cancelled may)'],
  [{ statusMap: { ...map, spec: 'Backlog' } }, 'github.statusMap.spec must not share the inbox option (only done and cancelled may)'],
  [{ label: 5 }, 'github.label must be text'],
  [{ label: '  ' }, 'github.label must be "" or a label name, not blank space'],
  [{ project: 5 }, 'github.project must be owner/number'],
  [{ statusMap: 'x' }, 'github.statusMap must map statuses to Project Status options'],
])('rejects %j', (over, error) => {
  expect(validateGitHubSettings(input(over), 'u')).toEqual({ ok: false, error });
});
test('done and cancelled may share inbox/ready options; names are trimmed', () => {
  const r = validateGitHubSettings(input({ statusMap: { ...map, done: 'Todo ', cancelled: 'Backlog' } }), 'u');
  expect(r).toMatchObject({ ok: true, value: { statusMap: { done: 'Todo', cancelled: 'Backlog' } } });
});

const checks = { server: { cwd: 's', build: 'b', test: 't' }, client: { cwd: 'c', install: 'i', typecheck: 'tc', lint: 'l', test: 't' }, e2e: 'off' as const };
const defOf = (id: string, github?: Record<string, unknown>): FactoryDef => {
  const r = validateFactoryDef({ factoryId: id, name: id, ...(github ? { github } : {}) });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const repoOf = (def: FactoryDef, repoId: string, remote: string): FactoryRepo => {
  const r = validateFactoryRepo({ repoId, remote, checks }, def);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const cfg = (mode: string) => ({ mode, project: 'kazi-lakit/3', statusMap: map });
const DUP = 'a GitHub repo can belong to only one factory repo';

describe('githubConfigProblems', () => {
  test('no github anywhere is clean', () => {
    const a = defOf('a');
    expect(githubConfigProblems([a], [repoOf(a, 'x', 'git@github.com:O/R.git')], 'file')).toEqual([]);
  });
  test('mode must match the store', () => {
    expect(githubConfigProblems([defOf('a', cfg('github-only'))], [], 'blocks')).toEqual([{ factoryId: 'a', message: 'github mode github-only needs the file store' }]);
    expect(githubConfigProblems([defOf('a', cfg('connected'))], [], 'file')).toEqual([{ factoryId: 'a', message: 'github mode connected needs the Blocks store' }]);
    expect(githubConfigProblems([defOf('a', cfg('connected'))], [], 'blocks')).toEqual([]);
  });
  test('one GitHub repo, one factory repo (case-insensitive, across factories)', () => {
    const a = defOf('a', cfg('github-only')); const b = defOf('b', cfg('github-only'));
    const ra = repoOf(a, 'x', 'git@github.com:O/R.git'); const rb = repoOf(b, 'y', 'https://github.com/o/r');
    expect(githubConfigProblems([b, a], [rb, ra], 'file')).toEqual([
      { factoryId: 'b', repoId: 'y', message: `O/R is already used by a/x; ${DUP}` },
    ]);
  });
  test('duplicates within one factory are flagged on the later repo', () => {
    const a = defOf('a', cfg('github-only'));
    expect(githubConfigProblems([a], [repoOf(a, 'y', 'https://github.com/o/r'), repoOf(a, 'x', 'git@github.com:O/R.git')], 'file')).toEqual([
      { factoryId: 'a', repoId: 'y', message: `O/R is already used by a/x; ${DUP}` },
    ]);
  });
  test('factories without github are ignored as owners and as duplicates', () => {
    const a = defOf('a'); const b = defOf('b', cfg('github-only')); const c = defOf('c');
    const repos = [repoOf(a, 'x', 'git@github.com:O/R.git'), repoOf(b, 'y', 'https://github.com/o/r'), repoOf(c, 'z', 'https://github.com/o/r')];
    expect(githubConfigProblems([a, b, c], repos, 'file')).toEqual([]);
  });
  test('a non-GitHub remote is flagged only with github on', () => {
    const a = defOf('a', cfg('github-only')); const b = defOf('b');
    const repos = [repoOf(a, 'x', 'git@gitlab.com:O/R.git'), repoOf(b, 'y', 'git@gitlab.com:O/R.git')];
    expect(githubConfigProblems([a, b], repos, 'file')).toEqual([{ factoryId: 'a', repoId: 'x', message: 'remote is not a GitHub repo; GitHub mode needs one' }]);
  });
  test('factory problems come before repo problems, factories in id order', () => {
    const a = defOf('a', cfg('connected')); const b = defOf('b', cfg('connected'));
    const repos = [repoOf(b, 'y', 'git@gitlab.com:O/R.git'), repoOf(a, 'x', 'git@gitlab.com:O/R.git')];
    expect(githubConfigProblems([b, a], repos, 'file').map((p) => [p.factoryId, p.repoId])).toEqual([['a', undefined], ['a', 'x'], ['b', undefined], ['b', 'y']]);
  });
});
