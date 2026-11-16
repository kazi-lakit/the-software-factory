// Node-only: which store a command uses, and where the local store keeps its files.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { saysFactoryApp } from './factoriesFs.js';
import { isValidId } from './factories.js';

/** The store kinds inside the core: `local` is `file`, `factory-app` is `blocks`. */
export type StoreKind = 'file' | 'blocks';

/** `local`/`file` is the file store, `factory-app`/`blocks` the Blocks store. */
export function parseStoreKind(value: string): StoreKind {
  if (value === 'local' || value === 'file') return 'file';
  if (value === 'factory-app' || value === 'blocks') return 'blocks';
  throw new Error('--store must be one of local, factory-app (or file, blocks)');
}

/** The folder of board.json and the lock files: `FACTORY_STORE_LOCAL_PATH` (absolute), else `<root>/.factory`. Not created. */
export function storeDirPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.FACTORY_STORE_LOCAL_PATH;
  if (custom && !isAbsolute(custom)) throw new Error('FACTORY_STORE_LOCAL_PATH must be an absolute path');
  return custom ? resolve(custom) : join(root, '.factory');
}

/** `storeDirPath`, created when missing. */
export function localStoreDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = storeDirPath(root, env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Whether the factory has a factory.yaml that is not factory-app. A file that cannot be read or parsed still counts: the YAML owns it. */
function isLocalFactory(factoriesDir: string, id: string): boolean {
  if (!isValidId(id)) return false;
  const file = join(factoriesDir, id, 'factory.yaml');
  if (!existsSync(file)) return false;
  try {
    return !saysFactoryApp(parse(readFileSync(file, 'utf8')));
  } catch {
    return true;
  }
}

/** A command that names only local factories uses the file store, whatever `kind` says; a mix of local and other factories is refused. */
export function storeForFactories(kind: StoreKind, named: string[] | undefined, factoriesDir: string): StoreKind {
  if (!named || named.length === 0) return kind;
  const local = named.filter((id) => isLocalFactory(factoriesDir, id));
  if (local.length === named.length) return 'file';
  if (local.length > 0) {
    const other = named.find((id) => !local.includes(id))!;
    throw new Error(`factories ${local[0]} (local) and ${other} cannot run in one command`);
  }
  return kind;
}
