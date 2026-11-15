import { existsSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fileLock } from '../src/pullLock.js';

describe('fileLock', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'factory-lock-'));

  test('acquires, is held for a second taker, and is free after release', async () => {
    const root = dir();
    const lock = fileLock(() => root);
    const release = await lock('f');
    expect(release).not.toBeNull();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(true);
    expect(await lock('f')).toBeNull();
    expect(await lock('g')).not.toBeNull();
    release!();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(false);
    expect(await lock('f')).not.toBeNull();
  });

  test('takes a lock older than 120 s', async () => {
    const root = dir();
    const lock = fileLock(() => root);
    await lock('f');
    const old = new Date(Date.now() - 121_000);
    utimesSync(join(root, '.factory', 'pull-f.lock'), old, old);
    expect(await lock('f')).not.toBeNull();
  });

  test('a fresh lock is not stale', async () => {
    const root = dir();
    const lock = fileLock(() => root);
    await lock('f');
    const recent = new Date(Date.now() - 100_000);
    utimesSync(join(root, '.factory', 'pull-f.lock'), recent, recent);
    expect(await lock('f')).toBeNull();
  });
});

describe('fileLock races', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'factory-lock-'));
  const aged = (root: string) => { const old = new Date(Date.now() - 121_000); utimesSync(join(root, '.factory', 'pull-f.lock'), old, old); };

  test('two takers on one stale lock: exactly one gets it', async () => {
    const root = dir();
    const lock = fileLock(() => root);
    await lock('f');
    aged(root);
    const got = await Promise.all([lock('f'), lock('f')]);
    expect(got.filter((r) => r !== null)).toHaveLength(1);
  });

  test('release after another holder took over does not delete the new lock', async () => {
    const root = dir();
    const lock = fileLock(() => root);
    const first = await lock('f');
    aged(root);
    const second = await lock('f');
    expect(second).not.toBeNull();
    first!();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(true);
    expect(await lock('f')).toBeNull();
    second!();
    expect(existsSync(join(root, '.factory', 'pull-f.lock'))).toBe(false);
  });

  test('a takeover leaves no stray files behind', async () => {
    const root = dir();
    const lock = fileLock(() => root);
    await lock('f');
    aged(root);
    (await lock('f'))!();
    expect(readdirSync(join(root, '.factory'))).toEqual([]);
  });
});
