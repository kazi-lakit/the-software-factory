import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { localStoreDir, parseStoreKind, storeForFactories } from '../src/storeSelect.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'store-select-'));
const yaml = (dir: string, id: string, text: string) => {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'factory.yaml'), text);
};
const LOCAL = 'factory:\n  id: loc\n  name: Loc\n  source: local\n';
const APP = 'factory:\n  id: app\n  name: App\n  source: factory-app\nboard:\n  source: factory-app\n';

describe('parseStoreKind', () => {
  test.each([['local', 'file'], ['file', 'file'], ['factory-app', 'blocks'], ['blocks', 'blocks']])('parseStoreKind(%s)', (v, k) => {
    expect(parseStoreKind(v)).toBe(k);
  });
  test('anything else throws', () => {
    expect(() => parseStoreKind('nope')).toThrow('--store must be one of local, factory-app (or file, blocks)');
    expect(() => parseStoreKind('')).toThrow('--store must be one of local, factory-app (or file, blocks)');
  });
});

describe('localStoreDir', () => {
  test('defaults to <root>/.factory, created', () => {
    const root = tmp();
    expect(localStoreDir(root, {})).toBe(join(root, '.factory'));
    expect(existsSync(join(root, '.factory'))).toBe(true);
    expect(localStoreDir(root, { FACTORY_STORE_LOCAL_PATH: '' })).toBe(join(root, '.factory'));
  });
  test('a relative FACTORY_STORE_LOCAL_PATH is refused; an absolute one is created', () => {
    expect(() => localStoreDir(tmp(), { FACTORY_STORE_LOCAL_PATH: 'rel/dir' })).toThrow('FACTORY_STORE_LOCAL_PATH must be an absolute path');
    const abs = join(tmp(), 'a', 'b');
    expect(localStoreDir(tmp(), { FACTORY_STORE_LOCAL_PATH: abs })).toBe(abs);
    expect(existsSync(abs)).toBe(true);
  });
});

describe('storeForFactories', () => {
  test('a named local factory uses the local store even when the kind is blocks', () => {
    const dir = tmp();
    yaml(dir, 'loc', LOCAL);
    yaml(dir, 'broken', 'factory: [oops');
    yaml(dir, 'old', 'factoryId: old\nname: Old\n'); // legacy shape without github: local
    expect(storeForFactories('blocks', ['loc'], dir)).toBe('file');
    expect(storeForFactories('blocks', ['loc', 'broken', 'old'], dir)).toBe('file');
  });
  test('no named factory, or a factory without YAML, keeps the given kind', () => {
    const dir = tmp();
    yaml(dir, 'app', APP);
    expect(storeForFactories('blocks', undefined, dir)).toBe('blocks');
    expect(storeForFactories('blocks', [], dir)).toBe('blocks');
    expect(storeForFactories('blocks', ['nope'], dir)).toBe('blocks');
    expect(storeForFactories('blocks', ['app'], dir)).toBe('blocks');
    expect(storeForFactories('file', ['app'], dir)).toBe('file');
  });
  test('local mixed with non-local is refused', () => {
    const dir = tmp();
    yaml(dir, 'loc', LOCAL);
    yaml(dir, 'app', APP);
    expect(() => storeForFactories('blocks', ['loc', 'app'], dir)).toThrow('factories loc (local) and app cannot run in one command');
    expect(() => storeForFactories('blocks', ['app', 'loc', 'x'], dir)).toThrow('factories loc (local) and app cannot run in one command');
    expect(() => storeForFactories('blocks', ['loc', 'nope'], dir)).toThrow('factories loc (local) and nope cannot run in one command');
  });
});
