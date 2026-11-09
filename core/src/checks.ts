import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { RepoConfig } from './repoConfig.js';

export type Exec = (cmd: string, cwd: string) => Promise<{ code: number; output: string }>;

export interface CheckStep {
  name: string;
  command: string;
  exitCode: number | null;
  output: string;
}

export interface CheckReport {
  passed: boolean;
  steps: CheckStep[];
}

const OUTPUT_LIMIT = 4000;

// Commands come from trusted repos/<repo>.yaml, so a shell is intended.
export const shellExec: Exec = (cmd, cwd) =>
  new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(cmd, { cwd, shell: true });
    } catch (e) {
      resolve({ code: 127, output: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => resolve({ code: 127, output: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });

export async function runChecks(cfg: RepoConfig, worktree: string, exec: Exec = shellExec): Promise<CheckReport> {
  const { server, client } = cfg.checks;
  const steps: CheckStep[] = [];

  const run = async (name: string, command: string, cwd: string, skip: boolean): Promise<boolean> => {
    if (skip) {
      steps.push({ name, command, exitCode: null, output: '' });
      return false;
    }
    const r = await exec(command, join(worktree, cwd));
    steps.push({ name, command, exitCode: r.code, output: r.output.slice(-OUTPUT_LIMIT) });
    return r.code === 0;
  };

  const built = await run('server.build', server.build, server.cwd, false);
  await run('server.test', server.test, server.cwd, !built);
  const installed = await run('client.install', client.install, client.cwd, false);
  await run('client.typecheck', client.typecheck, client.cwd, !installed);
  await run('client.lint', client.lint, client.cwd, !installed);
  await run('client.test', client.test, client.cwd, !installed);

  return { passed: steps.every((s) => s.exitCode === 0), steps };
}

export function formatReport(r: CheckReport): string {
  const lines = r.steps.map((s) =>
    s.exitCode === null ? `- ⏭ ${s.name} (skipped)` : s.exitCode === 0 ? `- ✅ ${s.name}` : `- ❌ ${s.name} (exit ${s.exitCode})`,
  );
  return [`## Checks: ${r.passed ? 'passed' : 'failed'}`, '', ...lines].join('\n');
}
