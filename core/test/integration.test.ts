import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { shellExec } from '../src/checks.js';
import { Engine, type EngineDeps } from '../src/engine.js';
import { LocalGitRepos } from '../src/git.js';
import { FakeGitHub } from '../src/github.js';
import { FactoryConfig } from '../src/factories.js';
import { defFixture, repoFixture } from './factoryFixtures.js';
import { nextTicket } from './nextTicket.js';
import { MemoryStore } from '../src/store.js';
import type { RepoId } from '../src/types.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

/** FakeGitHub only parses github.com remotes; the engine passes the temp bare repo path, so give it a github-shaped one. */
class PathRemoteGitHub extends FakeGitHub {
  override openPr(p: Parameters<FakeGitHub['openPr']>[0]) {
    return super.openPr({ ...p, remote: 'git@github.com:SELISEdigitalplatforms/blocks-data.git' });
  }
  override findOpenPr(p: Parameters<FakeGitHub['findOpenPr']>[0]) {
    return super.findOpenPr({ ...p, remote: 'git@github.com:SELISEdigitalplatforms/blocks-data.git' });
  }
}

let tmp: string;
let bare: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'factory-integration-')));
  const seed = join(tmp, 'seed');
  bare = join(tmp, 'remote.git');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'dev');
  for (const d of ['server', 'client']) {
    mkdirSync(join(seed, d));
    writeFileSync(join(seed, d, '.keep'), '');
  }
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(tmp, 'clone', '-q', '--bare', seed, bare);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setup(clientTest = 'true') {
  const cfg = repoFixture('blocks', 'data', {
    remote: bare,
    checks: {
      server: { cwd: 'server', build: 'true', test: 'true' },
      client: { cwd: 'client', install: 'true', typecheck: 'true', lint: 'true', test: clientTest },
      e2e: 'off',
    },
  });
  const store = new MemoryStore();
  const github = new PathRemoteGitHub();
  const deps: EngineDeps = {
    store,
    git: new LocalGitRepos(join(tmp, 'factory')),
    githubFor: () => github,
    factories: async () => new FactoryConfig([defFixture('blocks')], [cfg]),
    exec: shellExec,
    now: () => new Date(),
    mode: 'session',
    claimant: 'me',
  };
  return { store, github, engine: new Engine(deps) };
}

const result = (r: object) => JSON.stringify(r);
const devSha = () => git(tmp, 'ls-remote', bare, 'refs/heads/dev').trim();

async function readyTask(store: MemoryStore) {
  const t = await store.createTask({ factoryId: 'blocks', title: 'Add widget', description: 'd', repo: 'data', baseBranch: 'dev' });
  await store.updateTask(t.taskId, t.version, { status: 'ready' });
}

async function buildOnce(engine: Engine, step: string, worktree: string, n: number) {
  expect(step).toBe('build');
  writeFileSync(join(worktree, `f${n}.txt`), String(n));
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', `change ${n}`);
  await engine.complete('T-1', 'build', result({ status: 'done', summary: 's' }));
}

describe('integration', () => {
  test('ready to pr_open with stubbed agents', async () => {
    const { store, github, engine } = setup();
    const before = devSha();
    await readyTask(store);

    let ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('spec');
    let task = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: '# Spec' }));
    expect(task.status).toBe('spec_review');

    const spec = await store.currentDoc('T-1', 'spec');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: spec!.version, decision: 'approve', comment: '' });
    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('plan');
    task = await engine.complete('T-1', 'plan', result({ status: 'done', summary: 's', doc: '# Plan' }));
    expect(task.status).toBe('build');

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('build');
    writeFileSync(join(ticket!.worktree, 'hello.txt'), 'hello');
    git(ticket!.worktree, 'add', '.');
    git(ticket!.worktree, 'commit', '-q', '-m', 'add hello');
    await engine.complete('T-1', 'build', result({ status: 'done', summary: 's' }));

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('check');
    await engine.check('T-1');

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('verify');
    await engine.complete('T-1', 'verify', result({ status: 'done', summary: 's', verdict: 'pass', doc: '# Verify' }));

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('review');
    await engine.complete('T-1', 'review', result({ status: 'done', summary: 's', verdict: 'approve', doc: '# Review' }));

    ticket = await nextTicket(engine);
    expect(ticket?.step).toBe('ship');
    task = await engine.ship('T-1');

    expect(task.status).toBe('pr_open');
    expect(github.prs.size).toBe(1);
    const [url, pr] = [...github.prs][0]!;
    expect(pr.base).toBe('dev');
    expect(pr.head).toMatch(/^factory\/T-1-/);
    expect(git(tmp, 'ls-remote', bare, `refs/heads/${pr.head}`)).toContain(`refs/heads/${pr.head}`);
    expect(devSha()).toBe(before);

    const moves = (await store.listEvents('T-1')).filter((e) => e.action === 'move').map((e) => `${e.from}→${e.to}`);
    expect(moves).toEqual([
      'ready→spec',
      'spec→spec_review',
      'spec_review→plan',
      'plan→build',
      'build→verify',
      'verify→review',
      'review→pr_open',
    ]);

    github.setState(url, 'merged');
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('done');
  });

  test('checks fail three times → blocked', async () => {
    const { store, engine } = setup('false');
    await readyTask(store);

    await nextTicket(engine);
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: '# Spec' }));
    const spec = await store.currentDoc('T-1', 'spec');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: spec!.version, decision: 'approve', comment: '' });
    await nextTicket(engine);
    await engine.complete('T-1', 'plan', result({ status: 'done', summary: 's', doc: '# Plan' }));

    for (let n = 1; n <= 3; n++) {
      const ticket = await nextTicket(engine);
      await buildOnce(engine, ticket!.step, ticket!.worktree, n);
      expect((await nextTicket(engine))?.step).toBe('check');
      await engine.check('T-1');
    }

    const task = await store.getTask('T-1');
    expect(task.status).toBe('blocked');
    expect(task.attempt).toBe(3);
    expect(task.blockedReason).toBe('returned to build 3 times');
  });
});
