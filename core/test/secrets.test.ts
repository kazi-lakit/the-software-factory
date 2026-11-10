import { describe, expect, test } from 'vitest';
import { GhLoginMissingError, readGhToken, readSecret, SecretMissingError, type ExecFile } from '../src/secrets.js';

describe('readSecret', () => {
  test('runs security with the exact args and trims the trailing newline', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFile = async (file, args) => {
      calls.push([file, args]);
      return { code: 0, stdout: 'tok123\n', stderr: '' };
    };
    expect(await readSecret('blocks-credential', exec)).toBe('tok123');
    expect(calls).toEqual([['security', ['find-generic-password', '-s', 'the-software-factory', '-a', 'blocks-credential', '-w']]]);
  });

  test('non-zero exit rejects with the exact message and leaks no output', async () => {
    const exec: ExecFile = async () => ({ code: 44, stdout: 'SECRET-LEAK', stderr: 'SECRET-LEAK' });
    const err = await readSecret('blocks-credential', exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretMissingError);
    expect((err as Error).message).toBe('blocks-credential not found in Keychain (service the-software-factory)');
    expect((err as Error).message).not.toContain('SECRET-LEAK');
  });
});

describe('realExecFile', () => {
  test('resolves with a failure code, not a crash, when the command cannot be spawned (with stdin)', async () => {
    const { realExecFile } = await import('../src/secrets.js');
    const r = await realExecFile('/nonexistent/factory-test-binary', [], 'input');
    expect(r.code).not.toBe(0);
  });
});

describe('readGhToken', () => {
  test('asks gh for the named account on github.com and trims the newline', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFile = async (file, args) => {
      calls.push([file, args]);
      return { code: 0, stdout: 'gho_abc\n', stderr: '' };
    };
    expect(await readGhToken('kazi-lakit', exec)).toBe('gho_abc');
    expect(calls).toEqual([['gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'kazi-lakit']]]);
  });

  test('a failed or empty gh answer rejects with the exact message and leaks no output', async () => {
    for (const r of [{ code: 1, stdout: 'SECRET-LEAK', stderr: 'SECRET-LEAK' }, { code: 0, stdout: '\n', stderr: '' }]) {
      const err = await readGhToken('kazi-lakit', async () => r).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SecretMissingError);
      expect((err as Error).message).toBe('gh account kazi-lakit is not logged in (run: gh auth login)');
      expect((err as Error).message).not.toContain('SECRET-LEAK');
    }
  });
});

describe('GhLoginMissingError', () => {
  test('is a SecretMissingError naming the login, with the readGhToken text (R16)', () => {
    const e = new GhLoginMissingError('octocat');
    expect(e).toBeInstanceOf(SecretMissingError);
    expect(e.user).toBe('octocat');
    expect(e.name).toBe('GhLoginMissingError');
    expect(e.message).toBe('gh account octocat is not logged in (run: gh auth login)');
  });

  test('readGhToken rejects with it', async () => {
    const err = await readGhToken('octocat', async () => ({ code: 1, stdout: '', stderr: '' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhLoginMissingError);
    expect(err).toMatchObject({ user: 'octocat' });
  });
});
