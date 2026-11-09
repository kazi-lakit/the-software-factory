// Doc size spike (USER-run): how large a String body does Blocks Data round-trip?
//   npm run -s blocks:spike-doc-size -- --confirm-synthetic-writes
// Writes synthetic rows to FactorySpike as factory-core and hard-deletes each one. Prints sizes and ok/failed only.
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadBlocksCredential } from '../src/blocks/credential.js';
import { SdkBlocksData, type BlocksData } from '../src/blocks/data.js';
import { ClientCredentialsToken } from '../src/blocks/token.js';

export const SPIKE_SIZES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024];
export const CONFIRM_FLAG = '--confirm-synthetic-writes';
export const REFUSAL = `refusing to run: this writes synthetic rows to Blocks; pass ${CONFIRM_FLAG}`;

export const sizeLabel = (bytes: number): string =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)}MiB` : `${bytes / 1024}KiB`;

const firstLine = (error: unknown): string => String(error instanceof Error ? error.message : error).split('\n')[0]!;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const UNIT = 'Spike body: ASCII text, café naïve üñ 漢字かな 😀 end.\n';

/** Deterministic markdown-ish text of exactly `bytes` UTF-8 bytes: repeated mixed ASCII and multi-byte characters, padded with ASCII. */
export function spikeBody(bytes: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const ch of UNIT.repeat(Math.ceil(bytes / Buffer.byteLength(UNIT)) + 1)) {
    const n = Buffer.byteLength(ch);
    if (used + n > bytes) break;
    parts.push(ch);
    used += n;
  }
  return parts.join('') + 'x'.repeat(bytes - used);
}

/** Runs each size; stops at the first failure. Returns true when every size round-tripped. */
export async function runSpike(data: BlocksData, opts: { sizes?: number[]; log: (line: string) => void }): Promise<boolean> {
  for (const size of opts.sizes ?? SPIKE_SIZES) {
    const label = sizeLabel(size);
    const body = spikeBody(size);
    const bodySha256 = sha256(body);
    const spikeKey = `spike-${size}-${randomUUID().slice(0, 8)}`;
    let itemId: string | undefined;
    let problem: string | undefined;
    try {
      const r = await data.insert('FactorySpike', { spikeKey, body, bodySha256 });
      if (r.kind === 'inserted') itemId = r.itemId;
      else throw new Error(`insert answered ${r.kind}`);
      const [row, ...more] = await data.list('FactorySpike', { spikeKey }, ['body']);
      if (!row || more.length) throw new Error('read-back found no single row');
      if (sha256(String(row.body ?? '')) !== bodySha256) throw new Error('read-back body differs (sha256 mismatch)');
    } catch (error) {
      problem = firstLine(error);
    } finally {
      // An insert that threw or answered duplicate may still have stored a row: find it by key.
      try {
        const ids = itemId !== undefined ? [itemId] : (await data.list('FactorySpike', { spikeKey }, [])).map((r) => String(r.ItemId));
        for (const id of ids) await data.hardDelete('FactorySpike', id);
      } catch (error) {
        opts.log(`cleanup needed: spikeKey ${spikeKey}`);
        problem ??= `delete failed: ${firstLine(error)}`;
      }
    }
    if (problem !== undefined) {
      opts.log(`${label} failed: ${problem}`);
      return false;
    }
    opts.log(`${label} ok`);
  }
  return true;
}

export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  if (!argv.includes(CONFIRM_FLAG)) {
    log(REFUSAL);
    return 2;
  }
  try {
    const cred = await loadBlocksCredential();
    const data = new SdkBlocksData({ apiUrl: cred.apiUrl, projectKey: cred.projectKey, token: new ClientCredentialsToken(cred), timeoutMs: 120_000 });
    return (await runSpike(data, { log })) ? 0 : 1;
  } catch (error) {
    log(`spike failed: ${firstLine(error)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
