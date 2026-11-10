// Pipe `blocks auth client-credentials save --json` into this tool:
//   blocks auth client-credentials save ... --json | npm run blocks:save-credential -- --project-key <id> --api-url <url>
// The secret goes on stdin only, to `security -i` (macOS) or `secret-tool store` (Linux); it is never printed or put in argv.
import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { BlocksCredential } from '../src/blocks/credential.js';
import { noSecretStore, readSecret, realExecFile, secretToolAttrs, type ExecFile } from '../src/secrets.js';

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
  // Hex keeps quotes, backslashes and any other character out of the command line.
  const hex = Buffer.from(JSON.stringify(cred), 'utf8').toString('hex');
  return `add-generic-password -U -s the-software-factory -a blocks-credential -X ${hex}`;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value !== undefined && value.startsWith('--') ? undefined : value;
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

export async function runSave(opts: { raw: string; argv: string[]; spawn?: Spawner; exec?: ExecFile; platform?: string }): Promise<{ code: number; stdout: string }> {
  const fail = (stdout: string) => ({ code: 1, stdout });
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return fail(`error: ${noSecretStore(platform)}`);
  const projectKey = flag(opts.argv, '--project-key');
  const apiUrl = flag(opts.argv, '--api-url');
  if (!projectKey || /\s/.test(projectKey)) return fail('error: --project-key must be non-empty with no whitespace');
  if (!apiUrl || !httpsUrl(apiUrl)) return fail('error: --api-url must be an https URL');
  let cred: BlocksCredential;
  try { cred = buildCredential(JSON.parse(opts.raw), projectKey, apiUrl); } catch { return fail('error: could not save blocks-credential'); }
  const spawn = opts.spawn ?? realSpawn;
  const { code } = platform === 'darwin'
    ? await spawn('security', ['-i'], `${keychainCommand(cred)}\n`)
    // secret-tool stores its standard input as it is, so no trailing newline.
    : await spawn('secret-tool', ['store', '--label=the-software-factory blocks-credential', ...secretToolAttrs('blocks-credential')], JSON.stringify(cred));
  if (code !== 0) return fail('error: could not save blocks-credential');
  // Read back and compare exactly; neither value is ever printed.
  try {
    const stored = await readSecret('blocks-credential', opts.exec ?? realExecFile, platform);
    if (stored.trim() !== JSON.stringify(cred)) return fail('error: could not save blocks-credential');
  } catch { return fail('error: could not save blocks-credential'); }
  return { code: 0, stdout: `saved blocks-credential (client ${cred.clientId})` };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size > 262144) break;
  }
  const out = await runSave({ raw: Buffer.concat(chunks).toString('utf8'), argv: process.argv.slice(2) });
  (out.code === 0 ? console.log : console.error)(out.stdout);
  process.exitCode = out.code;
}
