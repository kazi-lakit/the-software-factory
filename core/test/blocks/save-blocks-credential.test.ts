import { describe, expect, it } from 'vitest';
import { buildCredential, keychainCommand, runSave, type Spawner } from '../../tools/save-blocks-credential.js';
import type { ExecFile } from '../../src/secrets.js';

const cred = { clientId: 'cid', clientSecret: 'S3CR3T-it\'s', projectKey: 'tenant1', apiUrl: 'https://api.example.com' };
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
  it('stores hex only after -X, whatever the secret contains', () => {
    const nasty = { ...cred, clientSecret: 'a\'b"c\\d\ne' };
    const line = keychainCommand(nasty);
    const prefix = 'add-generic-password -U -s the-software-factory -a blocks-credential -X ';
    expect(line.startsWith(prefix)).toBe(true);
    const hex = line.slice(prefix.length);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(hex, 'hex').toString('utf8')).toBe(JSON.stringify(nasty));
  });
});

describe('runSave', () => {
  const raw = JSON.stringify({ clientId: 'cid', clientSecret: 'TOPSECRET' });
  const argv = ['--project-key', 'tenant1', '--api-url', 'https://api.example.com'];
  const expected = JSON.stringify({ clientId: 'cid', clientSecret: 'TOPSECRET', projectKey: 'tenant1', apiUrl: 'https://api.example.com' });
  const execOf = (stdout: string, code = 0): ExecFile => async () => ({ code, stdout, stderr: '' });
  const make = (code: number) => {
    const calls: { file: string; args: string[]; stdin: string }[] = [];
    const spawn: Spawner = async (file, args, stdin) => { calls.push({ file, args, stdin }); return { code }; };
    return { calls, spawn };
  };
  it('puts the secret only in stdin and prints only the client id', async () => {
    const { calls, spawn } = make(0);
    const out = await runSave({ platform: 'darwin', raw, argv, spawn, exec: execOf(expected + '\n') });
    expect(out).toEqual({ code: 0, stdout: 'saved blocks-credential (client cid)' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('security');
    expect(calls[0].args).toEqual(['-i']);
    expect(Buffer.from(calls[0].stdin.split(' -X ')[1].split('\n')[0], 'hex').toString()).toContain('TOPSECRET');
    expect(calls[0].stdin).not.toContain('TOPSECRET');
    expect(calls[0].stdin).toMatch(/^add-generic-password -U -s the-software-factory -a blocks-credential -X [0-9a-f]+\n$/);
    expect(calls[0].stdin).not.toContain('quit');
    expect(JSON.stringify(calls[0].args)).not.toContain('TOPSECRET');
    expect(out.stdout).not.toContain('TOPSECRET');
  });
  it('errors on read-back mismatch or failure without printing either value', async () => {
    for (const exec of [execOf('{"other":"LEAKME"}\n'), execOf('', 44)]) {
      const { spawn } = make(0);
      const out = await runSave({ platform: 'darwin', raw, argv, spawn, exec });
      expect(out).toEqual({ code: 1, stdout: 'error: could not save blocks-credential' });
    }
  });
  it('fails with a fixed message on a non-zero exit', async () => {
    const { spawn } = make(1);
    const out = await runSave({ platform: 'darwin', raw, argv, spawn, exec: execOf(expected) });
    expect(out).toEqual({ code: 1, stdout: 'error: could not save blocks-credential' });
  });
  it('validates flags and never spawns on bad input', async () => {
    const { calls, spawn } = make(0);
    for (const argv of [[], ['--project-key', '--api-url', 'https://x.io'], ['--project-key', 'a b', '--api-url', 'https://x.io'], ['--project-key', 'a', '--api-url', 'http://x.io'], ['--project-key', 'a', '--api-url', 'nope']]) {
      expect((await runSave({ platform: 'darwin', raw, argv, spawn })).code).toBe(1);
    }
    expect((await runSave({ platform: 'darwin', raw: 'garbage TOPSECRET', argv: ['--project-key', 'a', '--api-url', 'https://x.io'], spawn })).stdout).not.toContain('TOPSECRET');
    expect(calls).toHaveLength(0);
  });
});

describe('runSave on Linux', () => {
  const raw = JSON.stringify({ clientId: 'cid', clientSecret: 'TOPSECRET' });
  const argv = ['--project-key', 'tenant1', '--api-url', 'https://api.example.com'];
  const expected = JSON.stringify({ clientId: 'cid', clientSecret: 'TOPSECRET', projectKey: 'tenant1', apiUrl: 'https://api.example.com' });
  const make = (code: number) => {
    const calls: { file: string; args: string[]; stdin: string }[] = [];
    const spawn: Spawner = async (file, args, stdin) => { calls.push({ file, args, stdin }); return { code }; };
    return { calls, spawn };
  };
  it('stores with secret-tool, the secret only in stdin, then reads it back', async () => {
    const { calls, spawn } = make(0);
    const reads: Array<[string, string[]]> = [];
    const exec: ExecFile = async (file, args) => { reads.push([file, args]); return { code: 0, stdout: expected, stderr: '' }; };
    const out = await runSave({ platform: 'linux', raw, argv, spawn, exec });
    expect(out).toEqual({ code: 0, stdout: 'saved blocks-credential (client cid)' });
    expect(calls).toEqual([{ file: 'secret-tool', args: ['store', '--label=the-software-factory blocks-credential', 'service', 'the-software-factory', 'account', 'blocks-credential'], stdin: expected }]);
    expect(reads).toEqual([['secret-tool', ['lookup', 'service', 'the-software-factory', 'account', 'blocks-credential']]]);
  });
  it('fails without printing the secret when secret-tool fails', async () => {
    const { spawn } = make(1);
    const out = await runSave({ platform: 'linux', raw, argv, spawn, exec: async () => ({ code: 0, stdout: expected, stderr: '' }) });
    expect(out).toEqual({ code: 1, stdout: 'error: could not save blocks-credential' });
  });
  it('refuses another platform without spawning', async () => {
    const { calls, spawn } = make(0);
    const out = await runSave({ platform: 'win32', raw, argv, spawn });
    expect(out).toEqual({ code: 1, stdout: 'error: no secret store on win32 (macOS Keychain or Linux secret-tool only)' });
    expect(calls).toEqual([]);
  });
});
