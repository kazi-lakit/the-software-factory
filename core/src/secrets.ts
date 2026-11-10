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

/** A factory's PAT is not in the Keychain. */
export class PatMissingError extends SecretMissingError {
  constructor(public readonly account: string) {
    super(`PAT ${account} not in Keychain`);
    this.name = 'PatMissingError';
  }
}

export const RESERVED_PAT_ACCOUNT = 'blocks-credential';

/** True for the reserved account, ignoring case and surrounding spaces. */
export const isReservedPatAccount = (account: string): boolean => account.trim().toLowerCase() === RESERVED_PAT_ACCOUNT;

export const KEYCHAIN_SERVICE = 'the-software-factory';
const SERVICE = KEYCHAIN_SERVICE;

/** Reads a secret from the macOS Keychain; `name` is the account (`blocks-credential`, or a factory's `patAccount`). Error messages never include command output. */
export async function readSecret(name: string, exec: ExecFile = realExecFile): Promise<string> {
  const { code, stdout } = await exec('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
  if (code !== 0) throw new SecretMissingError(`${name} not found in Keychain (service ${SERVICE})`);
  return stdout.replace(/\r?\n$/, '');
}
