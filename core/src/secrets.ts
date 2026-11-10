import { execFile } from 'node:child_process';

export type ExecFile = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Real implementation: never rejects on a non-zero exit, returns the code instead. */
export const realExecFile: ExecFile = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
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

const SERVICE = 'the-software-factory';

/** Reads a secret from the macOS Keychain; `name` is the account (`blocks-credential`, or a factory's `patAccount`). Error messages never include command output. */
export async function readSecret(name: string, exec: ExecFile = realExecFile): Promise<string> {
  const { code, stdout } = await exec('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
  if (code !== 0) throw new SecretMissingError(`${name} not found in Keychain (service ${SERVICE})`);
  return stdout.replace(/\r?\n$/, '');
}
