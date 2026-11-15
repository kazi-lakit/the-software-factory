// The gh CLI calls the wizard needs. Logins only: no token is read here.
import { spawn } from 'node:child_process';
import { realExecFile, type ExecFile } from '../secrets.js';

export interface GhCli {
  /** The github.com logins gh holds with a working token, as gh spells them. */
  logins(): Promise<string[]>;
  /** `gh auth login`, interactive; resolves when gh exits. */
  login(): Promise<void>;
  /** `gh auth refresh -s project` for this login, interactive. */
  refreshProjectScope(login: string): Promise<void>;
}

/** Runs gh with the terminal attached; resolves with its exit code. */
export type RunInteractive = (args: string[]) => Promise<number>;

const runInherit: RunInteractive = (args) =>
  new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });

const HOST = ['--hostname', 'github.com'];

/** Logins from `gh auth status --json hosts` whose state is success; empty when gh fails or prints something unreadable. */
async function readLogins(exec: ExecFile): Promise<string[]> {
  try {
    const { code, stdout } = await exec('gh', ['auth', 'status', ...HOST, '--json', 'hosts']);
    if (code !== 0) return [];
    const accounts = (JSON.parse(stdout) as { hosts?: Record<string, unknown> } | null)?.hosts?.['github.com'];
    if (!Array.isArray(accounts)) return [];
    const out: string[] = [];
    for (const a of accounts as Array<{ login?: unknown; state?: unknown } | null>) {
      if (typeof a?.login === 'string' && a.state === 'success' && !out.includes(a.login)) out.push(a.login);
    }
    return out;
  } catch {
    return [];
  }
}

/** The real gh. Login and refresh run with stdio inherited; the refresh switches to the login first when gh has several. */
export function realGhCli(exec: ExecFile = realExecFile, run: RunInteractive = runInherit): GhCli {
  return {
    logins: () => readLogins(exec),
    async login() {
      await run(['auth', 'login', ...HOST]);
    },
    async refreshProjectScope(login) {
      if ((await readLogins(exec)).length > 1) await exec('gh', ['auth', 'switch', ...HOST, '--user', login]);
      await run(['auth', 'refresh', ...HOST, '-s', 'project']);
    },
  };
}
