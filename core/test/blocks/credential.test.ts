import { describe, expect, it } from 'vitest';
import { loadBlocksCredential } from '../../src/blocks/credential.js';
import { buildCredential, keychainCommand, runSave, type Spawner } from '../../tools/save-blocks-credential.js';
import type { ExecFile } from '../../src/secrets.js';

const cred = { clientId: 'cid', clientSecret: 'S3CR3T-it\'s', projectKey: 'tenant1', apiUrl: 'https://api.example.com' };
const execOf = (stdout: string, code = 0): ExecFile => async () => ({ code, stdout, stderr: '' });

describe('loadBlocksCredential', () => {
  it('returns the parsed credential', async () => {
    expect(await loadBlocksCredential(execOf(JSON.stringify(cred) + '\n'))).toEqual(cred);
  });
  it('throws the fixed message on a bad shape without echoing the value', async () => {
    const msg = 'blocks-credential in Keychain is not valid JSON {clientId, clientSecret, projectKey, apiUrl}';
    for (const bad of ['{"clientId":"x","clientSecret":"LEAKME"}', 'not json LEAKME']) {
      const err = await loadBlocksCredential(execOf(bad)).catch((e: Error) => e);
      expect((err as Error).message).toBe(msg);
      expect((err as Error).message).not.toContain('LEAKME');
    }
  });
});

describe('buildCredential / keychainCommand', () => {
  it('extracts nested clientSecret and itemId fallback', () => {
    const c = buildCredential({ data: { itemId: 'item1', clientSecret: 'sec' } }, 'tenant1', 'https://a.example.com');
    expect(c).toEqual({ clientId: 'item1', clientSecret: 'sec', projectKey: 'tenant1', apiUrl: 'https://a.example.com' });
  });
  it('prefers explicit clientId and accepts snake_case', () => {
    expect(buildCredential({ client_id: 'a', client_secret: 'b', itemId: 'z' }, 'p', 'https://x.io').clientId).toBe('a');
  });
  it('throws a fixed message on bad shapes, never echoing input', () => {
    for (const bad of [null, 'LEAKME', { code: 'LEAKME' }, { clientSecret: '' }, { clientSecret: 'LEAKME' }]) {
      try { buildCredential(bad, 'p', 'https://x.io'); throw new Error('no throw'); } catch (e) {
        expect((e as Error).message).toBe('unexpected output from blocks auth client-credentials save');
        expect((e as Error).message).not.toContain('LEAKME');
      }
    }
  });
  it('escapes single quotes', () => {
    const line = keychainCommand(cred);
    expect(line.startsWith("add-generic-password -U -s the-software-factory -a blocks-credential -w '")).toBe(true);
    expect(line).toContain("it'\\''s");
    expect(line.endsWith("'")).toBe(true);
  });
});

describe('runSave', () => {
  const raw = JSON.stringify({ clientId: 'cid', clientSecret: 'TOPSECRET' });
  const make = (code: number) => {
    const calls: { file: string; args: string[]; stdin: string }[] = [];
    const spawn: Spawner = async (file, args, stdin) => { calls.push({ file, args, stdin }); return { code }; };
    return { calls, spawn };
  };
  it('puts the secret only in stdin and prints only the client id', async () => {
    const { calls, spawn } = make(0);
    const out = await runSave({ raw, argv: ['--project-key', 'tenant1', '--api-url', 'https://api.example.com'], spawn });
    expect(out).toEqual({ code: 0, stdout: 'saved blocks-credential (client cid)' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('security');
    expect(calls[0].args).toEqual(['-i']);
    expect(calls[0].stdin).toContain('TOPSECRET');
    expect(calls[0].stdin.endsWith('\nquit\n')).toBe(true);
    expect(JSON.stringify(calls[0].args)).not.toContain('TOPSECRET');
    expect(out.stdout).not.toContain('TOPSECRET');
  });
  it('fails with a fixed message on a non-zero exit', async () => {
    const { spawn } = make(1);
    const out = await runSave({ raw, argv: ['--project-key', 'tenant1', '--api-url', 'https://api.example.com'], spawn });
    expect(out).toEqual({ code: 1, stdout: 'error: could not save blocks-credential' });
  });
  it('validates flags and never spawns on bad input', async () => {
    const { calls, spawn } = make(0);
    for (const argv of [[], ['--project-key', 'a b', '--api-url', 'https://x.io'], ['--project-key', 'a', '--api-url', 'http://x.io'], ['--project-key', 'a', '--api-url', 'nope']]) {
      expect((await runSave({ raw, argv, spawn })).code).toBe(1);
    }
    expect((await runSave({ raw: 'garbage TOPSECRET', argv: ['--project-key', 'a', '--api-url', 'https://x.io'], spawn })).stdout).not.toContain('TOPSECRET');
    expect(calls).toHaveLength(0);
  });
});
