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

const SERVICE = 'the-software-factory';

/** Reads a secret from the macOS Keychain. Error messages never include command output. */
export async function readSecret(name: 'github-pat' | 'blocks-credential', exec: ExecFile = realExecFile): Promise<string> {
  const { code, stdout } = await exec('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
  if (code !== 0) throw new SecretMissingError(`${name} not found in Keychain (service ${SERVICE})`);
  return stdout.replace(/\r?\n$/, '');
}

/** The gh CLI login whose token the factory uses for GitHub API calls: `FACTORY_GH_USER`, else `kazi-lakit`. */
export function githubUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.FACTORY_GH_USER || 'kazi-lakit';
}

/** Reads the GitHub token of a gh CLI login (`gh auth token`). Error messages never include command output. */
export async function readGhToken(user: string, exec: ExecFile = realExecFile): Promise<string> {
  const { code, stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com', '--user', user]);
  const token = stdout.trim();
  if (code !== 0 || !token) throw new SecretMissingError(`gh account ${user} is not logged in (run: gh auth login)`);
  return token;
}
