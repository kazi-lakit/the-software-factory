import { existsSync, mkdtempSync, utimesSync } from 'node:fs';
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
