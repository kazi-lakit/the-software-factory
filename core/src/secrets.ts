import { execFile } from 'node:child_process';

/** `stdin`, when given, is written to the child's standard input (never put it on the command line). */
export type ExecFile = (file: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Real implementation: never rejects on a non-zero exit, returns the code instead. */
export const realExecFile: ExecFile = (file, args, stdin) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (r: { code: number; stdout: string; stderr: string }) => {
      if (!settled) { settled = true; resolve(r); }
    };
    const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      done({ code, stdout, stderr });
    });
    // A spawn failure or a closed pipe (EPIPE) resolves with a failure code instead of crashing the process.
    child.on('error', () => done({ code: 1, stdout: '', stderr: '' }));
    child.stdin?.on('error', () => done({ code: 1, stdout: '', stderr: '' }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export class SecretMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretMissingError';
  }
}

/** A factory's gh login is not logged in on this machine (no token from `gh auth token`). */
export class GhLoginMissingError extends SecretMissingError {
  constructor(public readonly user: string) {
    super(`gh account ${user} is not logged in (run: gh auth login)`);
    this.name = 'GhLoginMissingError';
  }
}

export const KEYCHAIN_SERVICE = 'the-software-factory';
const SERVICE = KEYCHAIN_SERVICE;

/** Reads a secret from the macOS Keychain; `name` is the account (`blocks-credential`). Error messages never include command output. */
export async function readSecret(name: string, exec: ExecFile = realExecFile): Promise<string> {
  const { code, stdout } = await exec('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
  if (code !== 0) throw new SecretMissingError(`${name} not found in Keychain (service ${SERVICE})`);
  return stdout.replace(/\r?\n$/, '');
}

/** Reads the GitHub token of a gh CLI login (`gh auth token`). Error messages never include command output. */
export async function readGhToken(user: string, exec: ExecFile = realExecFile): Promise<string> {
  const { code, stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com', '--user', user]);
  const token = stdout.trim();
  if (code !== 0 || !token) throw new GhLoginMissingError(user);
  return token;
}
