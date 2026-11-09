import { describe, expect, it } from 'vitest';
import { formatReport, runChecks, shellExec, type Exec } from '../src/checks.js';
import type { RepoConfig } from '../src/repoConfig.js';

const cfg: RepoConfig = {
  repo: 'os',
  remote: 'x/y',
  baseBranch: 'dev',
  checks: {
    server: { cwd: 'server', build: 'dotnet build', test: 'dotnet test' },
    client: { cwd: 'client', install: 'npm ci', typecheck: 'npm run tc', lint: 'npm run lint', test: 'npm test' },
    e2e: 'off',
  },
};

function stub(failing: string[] = [], output = 'ok') {
  const calls: { cmd: string; cwd: string }[] = [];
  const exec: Exec = async (cmd, cwd) => {
    calls.push({ cmd, cwd });
    return { code: failing.includes(cmd) ? 1 : 0, output };
  };
  return { calls, exec };
}

describe('runChecks', () => {
  it('skips server.test when build fails but still runs client steps', async () => {
    const { calls, exec } = stub(['dotnet build']);
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.passed).toBe(false);
    expect(r.steps.map((s) => s.name)).toEqual([
      'server.build', 'server.test', 'client.install', 'client.typecheck', 'client.lint', 'client.test',
    ]);
    const t = r.steps[1]!;
    expect(t.exitCode).toBeNull();
    expect(t.output).toBe('');
    expect(calls.map((c) => c.cmd)).not.toContain('dotnet test');
    expect(calls.map((c) => c.cmd)).toContain('npm test');
  });

  it('passes cwd per group', async () => {
    const { calls, exec } = stub();
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.passed).toBe(true);
    expect(calls.find((c) => c.cmd === 'dotnet build')!.cwd).toBe('/wt/server');
    expect(calls.find((c) => c.cmd === 'npm ci')!.cwd).toBe('/wt/client');
  });

  it('skips remaining client steps when install fails', async () => {
    const { exec } = stub(['npm ci']);
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.steps.slice(2).map((s) => s.exitCode)).toEqual([1, null, null, null]);
    expect(r.steps[0]!.exitCode).toBe(0);
  });

  it('keeps the last 4000 characters of output', async () => {
    const { exec } = stub([], 'a'.repeat(6000) + 'b'.repeat(4000));
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.steps[0]!.output).toBe('b'.repeat(4000));
  });
});

describe('formatReport', () => {
  it('lists a line per step', async () => {
    const { exec } = stub(['dotnet build']);
    const text = formatReport(await runChecks(cfg, '/wt', exec));
    expect(text.split('\n').slice(0, 2)).toEqual(['## Checks: failed', '']);
    expect(text).toContain('- ❌ server.build (exit 1)');
    expect(text).toContain('- ✅ client.lint');
    expect(text).toContain('- ⏭ server.test (skipped)');
  });

  it('says passed when all pass', async () => {
    const { exec } = stub();
    expect(formatReport(await runChecks(cfg, '/wt', exec)).startsWith('## Checks: passed\n\n')).toBe(true);
  });
});

describe('shellExec', () => {
  it('returns exit code and merged output', async () => {
    const r = await shellExec('echo hi && exit 3', process.cwd());
    expect(r.code).toBe(3);
    expect(r.output).toContain('hi');
  });
});
