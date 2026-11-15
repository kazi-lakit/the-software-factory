import { mkdirSync, openSync, closeSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PullLock } from './githubPuller.js';

const STALE_MS = 120_000;

/** One pull per factory at a time: an exclusive lock file `<root>/.factory/pull-<factoryId>.lock`, stale after 120 s. A held lock gives null; other fs errors throw. */
export function fileLock(root: () => string, now: () => number = Date.now): PullLock {
  return async (factoryId) => {
    const dir = join(root(), '.factory');
    const path = join(dir, `pull-${factoryId}.lock`);
    mkdirSync(dir, { recursive: true });
    const take = (): boolean => {
      try {
        closeSync(openSync(path, 'wx'));
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
    };
    const release = () => rmSync(path, { force: true });
    if (take()) return release;
    let age: number;
    try {
      age = now() - statSync(path).mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return take() ? release : null;
      throw e;
    }
    if (age <= STALE_MS) return null;
    rmSync(path, { force: true });
    return take() ? release : null;
  };
}
