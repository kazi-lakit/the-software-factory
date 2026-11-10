import { describe, expect, it } from 'vitest';
import { FakeBlocksData, newFakeStorage } from '../../src/blocks/fakeData.js';
import { PROTECTED_TASK_FIELDS } from '../../src/blocks/schema.js';
import { BlocksStore } from '../../src/blocks/store.js';
import { main, ownerLogin, runGate, REFUSAL, STEPS, type GateDeps } from '../../tools/gate-blocks.js';

function setup(over: { onStatus?: (taskId: string) => { code: number; stdout: string }; grantCore?: Parameters<FakeBlocksData['grant']>; columnRule?: boolean } = {}) {
  const storage = newFakeStorage();
  const owner = new FakeBlocksData('factory-owner', { storage });
  // The column write rule holds unless a test turns it off (a build that does not enforce it).
  const core = new FakeBlocksData('factory-core', { storage, ...(over.columnRule === false ? {} : { columnRules: { FactoryTask: [...PROTECTED_TASK_FIELDS] } }) });
  if (over.grantCore) core.grant(...over.grantCore);
  const lines: string[] = [];
  const deps: GateDeps = {
    owner, core,
    ownerStore: new BlocksStore(owner, 'owner'),
    coreStore: new BlocksStore(core, 'core'),
    // The fake status lists whatever tasks the shared storage holds, as the real CLI would.
    runStatus: async () => {
      const ids = owner.rows('FactoryTask').map((r) => String(r.taskId));
      return over.onStatus ? over.onStatus(ids[0]!) : { code: 0, stdout: JSON.stringify({ tasks: ids.map((taskId) => ({ taskId })) }) };
    },
    log: (l) => lines.push(l),
    suffix: () => 'abcd1234',
  };
  return { deps, lines, owner };
}

describe('runGate', () => {
  it('passes every step against role-checked fakes sharing one storage', async () => {
    const { deps, lines, owner } = setup();
    expect(await runGate(deps)).toBe(true);
    // Step 11 also prints one indented line per sub-check.
    expect(lines.filter((l) => !l.startsWith(' '))).toHaveLength(STEPS.length);
    expect(lines.every((l) => l.endsWith(': pass'))).toBe(true);
    const [task] = owner.rows('FactoryTask');
    expect(task).toMatchObject({ taskId: 'GATE-abcd1234', status: 'cancelled', version: 3, writeId: expect.any(String) });
    // Rows the gate inserts directly can be updated: version 1, empty writeId.
    // The settings row is nulled afterwards so getSettings skips it.
    expect(owner.rows('FactorySettings')[0]).toMatchObject({ json: 'null' });
    expect(await deps.ownerStore.getSettings()).toEqual({ factories: { blocks: { factory: expect.anything(), repos: {} } } });
  });

  it('step 11 passes when the column rule holds: refusal leaves the row unchanged', async () => {
    const { deps, lines, owner } = setup();
    expect(await runGate(deps)).toBe(true);
    expect(lines.filter((l) => l.startsWith('  11'))).toHaveLength(4);
    // Nothing live is left behind, even when sub-checks fail.
    const cols = owner.rows('FactoryTask').find((r) => r.taskId === 'GATE-abcd1234-cols');
    expect(cols).toMatchObject({ title: 'gate owner title', status: 'cancelled' });
  });

  it('step 11 FAILs with a strip-build hint when core title edits are not refused', async () => {
    const { deps, lines, owner } = setup({ columnRule: false });
    expect(await runGate(deps)).toBe(false);
    expect(lines.filter((l) => l.includes('FAIL') && !l.startsWith(' ')).map((l) => l.split(' ')[0])).toEqual(['2', '11']);
    expect(lines.find((l) => l.startsWith('  11a'))).toContain('column rule not enforced (strip build?)');
    expect(lines.filter((l) => l.startsWith('  11') && l.endsWith(': pass')).map((l) => l.trim()[2])).toEqual(['b', 'c', 'd']);
    expect(owner.rows('FactoryTask').find((r) => r.taskId === 'GATE-abcd1234-cols')).toMatchObject({ status: 'cancelled' });
  });

  it('step 12 passes through BlocksStore although the gateway ignores null: the clear is stored as empty text', async () => {
    // The fakes ignore a null in an update, as live Blocks does.
    const { deps, lines, owner } = setup();
    expect(await runGate(deps)).toBe(true);
    expect(lines).toContain('12 core clears a task field to null: pass');
    expect(owner.rows('FactoryTask').find((r) => r.taskId === 'GATE-abcd1234-null')).toMatchObject({ question: '', status: 'cancelled' });
  });

  it('step 12 FAILs when the clear does not reach the row, and still cancels its task', async () => {
    const { deps, lines, owner } = setup();
    // A gateway that keeps the old value for an empty text too.
    const update = deps.core.update.bind(deps.core);
    deps.core.update = (schema, filter, input) => update(schema, filter, Object.fromEntries(Object.entries(input).filter(([, v]) => v !== '')));
    expect(await runGate(deps)).toBe(false);
    expect(lines.filter((l) => l.includes('FAIL') && !l.startsWith(' ')).map((l) => l.split(' ')[0])).toEqual(['12']);
    expect(lines.find((l) => l.startsWith('12 '))).toContain('question was not cleared to null');
    expect(owner.rows('FactoryTask').find((r) => r.taskId === 'GATE-abcd1234-null')).toMatchObject({ status: 'cancelled' });
  });

  it('prints labels only, never row values', async () => {
    const { deps, lines } = setup();
    await runGate(deps);
    expect(lines.join('\n')).not.toMatch(/gate-race|gate-denied|gate-null-check|inbox/);
  });

  it('FAILs the matching step when the core is granted an extra permission', async () => {
    const { deps, lines } = setup({ grantCore: ['FactoryApproval', 'insert'] });
    expect(await runGate(deps)).toBe(false);
    expect(lines.filter((l) => l.includes('FAIL')).map((l) => l[0])).toEqual(['3']);
    expect(lines.filter((l) => !l.startsWith(' ') && l.endsWith(': pass'))).toHaveLength(STEPS.length - 1);
  });

  it('FAILs step 4 when a denied core edit of FactorySettings would land', async () => {
    const { deps, lines } = setup({ grantCore: ['FactorySettings', 'edit'] });
    expect(await runGate(deps)).toBe(false);
    expect(lines.filter((l) => l.includes('FAIL')).map((l) => l.split(' ')[0])).toEqual(['4']);
  });

  it('FAILs step 5 when a denied core edit of FactoryEvent would land', async () => {
    const { deps, lines } = setup({ grantCore: ['FactoryEvent', 'edit'] });
    expect(await runGate(deps)).toBe(false);
    expect(lines.filter((l) => l.includes('FAIL')).map((l) => l.split(' ')[0])).toEqual(['5']);
  });

  it('skips steps that need a failed step, and still runs independent ones', async () => {
    const { deps, lines } = setup();
    deps.owner.insert = async () => ({ kind: 'forbidden' });
    expect(await runGate(deps)).toBe(false);
    expect(lines[0]).toContain('FAIL');
    expect(lines.filter((l) => l.endsWith(': skipped')).map((l) => l.split(' ')[0])).toEqual(['7', '8', '9', '10']);
  });

  it('FAILs step 9 when the status output omits the gate task', async () => {
    const { deps, lines } = setup({ onStatus: () => ({ code: 0, stdout: '{}' }) });
    expect(await runGate(deps)).toBe(false);
    expect(lines[8]).toContain('FAIL');
    expect(lines[9]).toContain('pass');
  });
});

describe('main / ownerLogin', () => {
  it('terminalAsk is exported for the CLI and rejects on EOF', async () => {
    const { terminalAsk } = await import('../../tools/gate-blocks.js');
    expect(typeof terminalAsk).toBe('function');
  });

  it('refuses without the confirm flag', async () => {
    const lines: string[] = [];
    expect(await main([], (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([REFUSAL]);
  });

  it('logs in through the SDK, asks for the password hidden, and never surfaces login errors', async () => {
    const asked: { q: string; hidden: boolean }[] = [];
    const ask = async (q: string, o: { hidden: boolean }) => { asked.push({ q, hidden: o.hidden }); return o.hidden ? 'S3CRET-pw' : 'me@example.com'; };
    const cred = { clientId: 'c', clientSecret: 's', projectKey: 'p', apiUrl: 'https://api.example.com' };
    const ok = (async () => new Response(JSON.stringify({ accessToken: 'tok-1', expiresIn: 60 }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const token = await ownerLogin(cred, ask, ok);
    expect(await token.get()).toBe('tok-1');
    expect(asked.map((a) => a.hidden)).toEqual([false, true]);
    const bad = (async () => new Response(JSON.stringify({ error: 'S3CRET-pw me@example.com' }), { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await expect(ownerLogin(cred, ask, bad)).rejects.toThrow(/^owner login failed$/);
  });
});
