// Pipe `blocks auth client-credentials save --json` into this tool:
//   blocks auth client-credentials save ... --json | npm run blocks:save-credential -- --project-key <id> --api-url <url>
// The secret goes to `security -i` on stdin only; it is never printed or put in argv.
import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { BlocksCredential } from '../src/blocks/credential.js';

export type Spawner = (file: string, args: string[], stdin: string) => Promise<{ code: number }>;

const BAD_SHAPE = 'unexpected output from blocks auth client-credentials save';
const stringAt = (holder: Record<string, unknown>, names: string[]) =>
  names.map((n) => holder[n]).find((v): v is string => typeof v === 'string' && v.length > 0);

/** The object that carries the client secret, at any depth: its clientId is the one that belongs to the secret. */
function secretHolder(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (stringAt(record, ['clientSecret', 'client_secret'])) return record;
  for (const inner of Object.values(record)) {
    const found = secretHolder(inner);
    if (found) return found;
  }
  return undefined;
}

export function buildCredential(cliJson: unknown, projectKey: string, apiUrl: string): BlocksCredential {
  const holder = secretHolder(cliJson);
  const clientSecret = holder && stringAt(holder, ['clientSecret', 'client_secret']);
  // Blocks identifies a client credential by itemId (its list has no clientId field); an explicit clientId still wins.
  const clientId = holder && stringAt(holder, ['clientId', 'client_id', 'itemId']);
  if (!clientSecret || !clientId) throw new Error(BAD_SHAPE);
  return { clientId, clientSecret, projectKey, apiUrl };
}

export function keychainCommand(cred: BlocksCredential): string {
  const json = JSON.stringify(cred).replaceAll("'", "'\\''");
  return `add-generic-password -U -s the-software-factory -a blocks-credential -w '${json}'`;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function httpsUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

const realSpawn: Spawner = (file, args, stdin) =>
  new Promise((resolve) => {
    const child = nodeSpawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve({ code: 1 }));
    child.on('close', (code) => resolve({ code: code ?? 1 }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });

export async function runSave(opts: { raw: string; argv: string[]; spawn?: Spawner }): Promise<{ code: number; stdout: string }> {
  const fail = (stdout: string) => ({ code: 1, stdout });
  const projectKey = flag(opts.argv, '--project-key');
  const apiUrl = flag(opts.argv, '--api-url');
  if (!projectKey || /\s/.test(projectKey)) return fail('error: --project-key must be non-empty with no whitespace');
  if (!apiUrl || !httpsUrl(apiUrl)) return fail('error: --api-url must be an https URL');
  let cred: BlocksCredential;
  try { cred = buildCredential(JSON.parse(opts.raw), projectKey, apiUrl); } catch { return fail('error: could not save blocks-credential'); }
  const { code } = await (opts.spawn ?? realSpawn)('security', ['-i'], `${keychainCommand(cred)}\nquit\n`);
  if (code !== 0) return fail('error: could not save blocks-credential');
  return { code: 0, stdout: `saved blocks-credential (client ${cred.clientId})` };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 262144) break;
  }
  const out = await runSave({ raw, argv: process.argv.slice(2) });
  console.log(out.stdout);
  process.exitCode = out.code;
}
