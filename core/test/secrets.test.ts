import { describe, expect, test } from 'vitest';
import { readSecret, SecretMissingError, type ExecFile } from '../src/secrets.js';

describe('readSecret', () => {
  test('runs security with the exact args and trims the trailing newline', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFile = async (file, args) => {
      calls.push([file, args]);
      return { code: 0, stdout: 'tok123\n', stderr: '' };
    };
    expect(await readSecret('github-pat', exec)).toBe('tok123');
    expect(calls).toEqual([['security', ['find-generic-password', '-s', 'the-software-factory', '-a', 'github-pat', '-w']]]);
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
