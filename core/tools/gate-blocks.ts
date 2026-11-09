// Live gate (USER-run): proves the deployed Blocks access rules and compare-and-set against both identities.
//   npm run -s blocks:gate -- --confirm-synthetic-writes
// Ported in structure from ACR tools/blocks-store/run-gate-roles.ts and run-race.ts. Writes synthetic GATE-* rows
// (they cannot be deleted: the Board tables have no delete rule). Prints step labels and pass/FAIL/skipped only,
// never row values, tokens or the password.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBlocksClient } from '@seliseblocks/client';
import { loadBlocksCredential, type BlocksCredential } from '../src/blocks/credential.js';
import { BlocksForbiddenError, SdkBlocksData, type BlocksData } from '../src/blocks/data.js';
import { BlocksStore } from '../src/blocks/store.js';
import { ClientCredentialsToken, type TokenSource } from '../src/blocks/token.js';
import { VersionConflictError } from '../src/store.js';
import { CONFIRM_FLAG, REFUSAL } from './spike-doc-size.js';

export { CONFIRM_FLAG, REFUSAL };

export type StatusRunner = () => Promise<{ code: number; stdout: string }>;
export type Ask = (question: string, opts: { hidden: boolean }) => Promise<string>;

export interface GateDeps {
  owner: BlocksData;
  core: BlocksData;
  ownerStore: BlocksStore;
  coreStore: BlocksStore;
  /** Runs `factory --store blocks status --json` and returns its exit code and stdout. */
  runStatus: StatusRunner;
  log: (line: string) => void;
  /** 8 hex characters; injectable for tests. */
  suffix?: () => string;
}

interface Ctx {
  taskId: string;
  suffix: string;
  /** ItemId of the gate task row, set by step 1. */
  taskItemId?: string;
}

interface Step {
  label: string;
  /** Step numbers that must have passed; otherwise this step is skipped. */
  needs?: number[];
  run(d: GateDeps, c: Ctx): Promise<void>;
}

const firstLine = (error: unknown): string => String(error instanceof Error ? error.message : error).split('\n')[0]!;

function expect(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

/** A task row for a direct insert: version 1 and an empty writeId, so the core can later update it. */
const taskRow = (taskId: string, status: string) => ({
  taskId, title: 'gate synthetic task', description: 'created by blocks:gate', repo: 'gate', baseBranch: 'dev', status,
  attempt: 0, costUsd: '0', gateOverrides: '{}', version: 1, writeId: '',
});

/** A write that is denied either way Blocks may answer: 403, or a not-applied update; the row must also be unchanged. */
async function expectDeniedUpdate(d: BlocksData, owner: BlocksData, schema: 'FactorySettings' | 'FactoryEvent', key: Record<string, string>, field: string, who: string): Promise<void> {
  const r = await d.update(schema, key, { [field]: 'gate-denied' });
  expect(r.kind === 'forbidden' || r.kind === 'not-applied', `${who} edit of ${schema} was ${r.kind}`);
  const [row] = await owner.list(schema, key, [field]);
  expect(row !== undefined && row[field] !== 'gate-denied', `${who} edit of ${schema} changed the row`);
}

export const STEPS: Step[] = [
  {
    label: '1 owner creates task, core reads it',
    async run(d, c) {
      const r = await d.owner.insert('FactoryTask', taskRow(c.taskId, 'inbox'));
      expect(r.kind === 'inserted', `owner insert of FactoryTask answered ${r.kind}`);
      c.taskItemId = r.kind === 'inserted' ? r.itemId : undefined;
      const rows = await d.core.list('FactoryTask', { taskId: c.taskId }, ['status']);
      expect(rows.length === 1 && rows[0]!.status === 'inbox', 'core could not read the gate task');
    },
  },
  {
    label: '2 core insert FactoryTask forbidden',
    async run(d, c) {
      const r = await d.core.insert('FactoryTask', taskRow(`GATE-${c.suffix}-core`, 'cancelled'));
      expect(r.kind === 'forbidden', `core insert of FactoryTask answered ${r.kind}`);
    },
  },
  {
    label: '3 FactoryApproval: core insert forbidden, owner insert ok',
    async run(d, c) {
      const row = (id: string) => ({ approvalId: id, taskId: c.taskId, gate: 'spec', docVersion: 1, decision: 'approve', comment: 'gate', at: new Date().toISOString() });
      const denied = await d.core.insert('FactoryApproval', row(`GATE-${c.suffix}-core`));
      expect(denied.kind === 'forbidden', `core insert of FactoryApproval answered ${denied.kind}`);
      const ok = await d.owner.insert('FactoryApproval', row(`GATE-${c.suffix}-owner`));
      expect(ok.kind === 'inserted', `owner insert of FactoryApproval answered ${ok.kind}`);
    },
  },
  {
    label: '4 FactorySettings: core edit forbidden, owner insert and edit ok',
    async run(d, c) {
      const scope = `gate-${c.suffix}`;
      const ins = await d.owner.insert('FactorySettings', { scope, json: '{}', version: 1, writeId: '' });
      expect(ins.kind === 'inserted', `owner insert of FactorySettings answered ${ins.kind}`);
      await expectDeniedUpdate(d.core, d.owner, 'FactorySettings', { scope }, 'json', 'core');
      const edit = await d.owner.update('FactorySettings', { scope }, { json: '{"gate":true}' });
      expect(edit.kind === 'applied', `owner edit of FactorySettings was ${edit.kind}`);
      // Rows cannot be deleted: a null json makes getSettings skip this scope.
      const cleared = await d.owner.update('FactorySettings', { scope }, { json: 'null' });
      expect(cleared.kind === 'applied', `owner clearing of the gate settings row was ${cleared.kind}`);
    },
  },
  {
    label: '5 FactoryEvent: core insert ok, core and owner edit forbidden',
    async run(d, c) {
      const eventId = `GATE-${c.suffix}`;
      const ins = await d.core.insert('FactoryEvent', { eventId, taskId: c.taskId, actor: 'gate', action: 'create', reason: 'gate', at: new Date().toISOString() });
      expect(ins.kind === 'inserted', `core insert of FactoryEvent answered ${ins.kind}`);
      await expectDeniedUpdate(d.core, d.owner, 'FactoryEvent', { eventId }, 'reason', 'core');
      await expectDeniedUpdate(d.owner, d.owner, 'FactoryEvent', { eventId }, 'reason', 'owner');
    },
  },
  {
    label: '6 FactoryDoc: owner insert forbidden, core insert ok',
    async run(d, c) {
      const row = (who: string) => ({ docKey: `GATE-${c.suffix}:${who}:1`, taskId: c.taskId, kind: 'spec', version: 1, body: 'gate', bodySha256: 'gate', author: who });
      const denied = await d.owner.insert('FactoryDoc', row('owner'));
      expect(denied.kind === 'forbidden', `owner insert of FactoryDoc answered ${denied.kind}`);
      const ok = await d.core.insert('FactoryDoc', row('core'));
      expect(ok.kind === 'inserted', `core insert of FactoryDoc answered ${ok.kind}`);
    },
  },
  {
    label: '7 compare-and-set race: one winner, one version conflict',
    needs: [1],
    async run(d, c) {
      const { version } = await d.coreStore.getTask(c.taskId);
      const results = await Promise.allSettled([
        d.coreStore.updateTask(c.taskId, version, { question: 'gate-race-a' }),
        d.coreStore.updateTask(c.taskId, version, { question: 'gate-race-b' }),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled').length;
      const conflicts = results.filter((r) => r.status === 'rejected' && r.reason instanceof VersionConflictError).length;
      expect(won === 1 && conflicts === 1, `race gave ${won} success and ${conflicts} version conflict of 2 calls`);
    },
  },
  {
    label: '8 FactoryTask delete forbidden for core and owner',
    needs: [1],
    async run(d, c) {
      for (const [who, data] of [['core', d.core], ['owner', d.owner]] as const) {
        let threw: 'forbidden' | 'other' | null = null;
        try { await data.hardDelete('FactoryTask', c.taskItemId!); } catch (error) { threw = error instanceof BlocksForbiddenError ? 'forbidden' : 'other'; }
        expect(threw !== null, `${who} delete of FactoryTask succeeded`);
        const rows = await d.owner.list('FactoryTask', { taskId: c.taskId }, ['status']);
        expect(rows.length === 1, `${who} delete of FactoryTask removed the row`);
      }
    },
  },
  {
    label: '9 factory --store blocks status --json lists the gate task',
    needs: [1],
    async run(d, c) {
      const r = await d.runStatus();
      expect(r.code === 0, `status exited with code ${r.code}`);
      expect(r.stdout.includes(c.taskId), 'status output does not list the gate task');
    },
  },
  {
    label: '10 owner cancels the gate task',
    needs: [1],
    async run(d, c) {
      const { version } = await d.ownerStore.getTask(c.taskId);
      const updated = await d.ownerStore.updateTask(c.taskId, version, { status: 'cancelled' });
      expect(updated.status === 'cancelled', 'gate task is not cancelled');
    },
  },
];

/** Runs every step in order; a FAIL does not stop later steps unless they need it (then they are skipped). Returns true if all passed. */
export async function runGate(d: GateDeps): Promise<boolean> {
  const suffix = (d.suffix ?? (() => randomUUID().slice(0, 8)))();
  const ctx: Ctx = { suffix, taskId: `GATE-${suffix}` };
  const passed = new Set<number>();
  let all = true;
  for (const [index, step] of STEPS.entries()) {
    const n = index + 1;
    if (step.needs?.some((need) => !passed.has(need))) {
      d.log(`${step.label}: skipped`);
      all = false;
      continue;
    }
    try {
      await step.run(d, ctx);
      passed.add(n);
      d.log(`${step.label}: pass`);
    } catch (error) {
      all = false;
      d.log(`${step.label}: FAIL (${firstLine(error)})`);
    }
  }
  return all;
}

/** A fixed token for a short run: an expired one surfaces as the typed unauthorized error and fails that step. */
class StaticToken implements TokenSource {
  constructor(private readonly token: string) {}
  get(): Promise<string> { return Promise.resolve(this.token); }
  invalidate(): void { /* no refresh for a short run */ }
}

/** SDK password login; errors are reduced to a fixed message because they can echo request data. */
export async function ownerLogin(cred: BlocksCredential, ask: Ask, fetchImpl?: typeof fetch): Promise<TokenSource> {
  const username = (await ask('Owner email: ', { hidden: false })).trim();
  const password = await ask('Owner password (hidden): ', { hidden: true });
  let answer: Record<string, unknown>;
  try {
    const client = createBlocksClient({ apiUrl: cred.apiUrl, xBlocksKey: cred.projectKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    answer = (await client.auth.login({ username, password })) as Record<string, unknown>;
  } catch { throw new Error('owner login failed'); }
  const token = answer?.accessToken ?? answer?.access_token;
  if (typeof token !== 'string' || !token) throw new Error('owner login failed');
  return new StaticToken(token);
}

/** Reads one line from the terminal; with `hidden` nothing is echoed. */
export const terminalAsk: Ask = (question, { hidden }) => new Promise((resolve, reject) => {
  let muted = false;
  let answered = false;
  const out = new Writable({ write(chunk, _enc, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  rl.on('close', () => { if (!answered) reject(new Error('no input')); });
  rl.question(question, (answer) => {
    answered = true;
    rl.close();
    if (hidden) process.stdout.write('\n');
    resolve(answer);
  });
  muted = hidden;
});

const factoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Runs the factory CLI against the blocks store as a child process (it reads the Keychain itself). */
export const realStatusRunner: StatusRunner = () => new Promise((resolve) => {
  execFile(`${factoryRoot}core/node_modules/.bin/tsx`, ['core/src/cli.ts', '--store', 'blocks', 'status', '--json'],
    { cwd: factoryRoot, env: { ...process.env, FACTORY_ROOT: factoryRoot }, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout) }));
});

export async function main(argv: string[], log: (line: string) => void = console.log, ask: Ask = terminalAsk): Promise<number> {
  if (!argv.includes(CONFIRM_FLAG)) {
    log(REFUSAL);
    return 2;
  }
  try {
    const cred = await loadBlocksCredential();
    const conn = { apiUrl: cred.apiUrl, projectKey: cred.projectKey, timeoutMs: 60_000 };
    const owner = new SdkBlocksData({ ...conn, token: await ownerLogin(cred, ask) });
    const core = new SdkBlocksData({ ...conn, token: new ClientCredentialsToken(cred) });
    const ok = await runGate({
      owner, core, ownerStore: new BlocksStore(owner, 'owner'), coreStore: new BlocksStore(core, 'core'), runStatus: realStatusRunner, log,
    });
    log(ok ? 'gate: all steps pass' : 'gate: FAILED');
    return ok ? 0 : 1;
  } catch (error) {
    log(`gate failed: ${firstLine(error)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main(process.argv.slice(2)));
}
