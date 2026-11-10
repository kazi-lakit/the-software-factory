// Node-only: the file-store layout (tests, smoke). The browser entry never imports this.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from './factories.js';

const readYaml = (file: string): unknown => parse(readFileSync(file, 'utf8'));
const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

/**
 * Reads `<dir>/<factoryId>/factory.yaml` and `<dir>/<factoryId>/repos/<repoId>.yaml`. Files that fail validation throw
 * with the file path, or with `onSkip` are skipped and reported; an absent `dir` is an empty tree.
 */
export function loadFactoriesFromDir(
  dir: string, onSkip?: (file: string, reason: string) => void,
): { defs: FactoryDef[]; repos: FactoryRepo[] } {
  /** With `onSkip` a bad file is skipped and reported; without it, it throws. */
  const bad = (file: string, reason: string): void => {
    if (!onSkip) throw new Error(`${file}: ${reason}`);
    onSkip(file, reason);
  };
  /** A file that cannot be parsed is as bad as one that fails validation. */
  const read = (file: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: readYaml(file) };
    } catch (e) {
      if (!onSkip) throw e;
      bad(file, e instanceof Error ? e.message : String(e));
      return { ok: false };
    }
  };
  const defs: FactoryDef[] = [];
  const repos: FactoryRepo[] = [];
  if (!existsSync(dir)) return { defs, repos };
  for (const id of dirs(dir)) {
    const file = join(dir, id, 'factory.yaml');
    if (!existsSync(file)) continue;
    const raw = read(file);
    if (!raw.ok) continue;
    const d = validateFactoryDef(raw.value);
    if (!d.ok) { bad(file, d.error); continue; }
    if (d.value.factoryId !== id) { bad(file, `factoryId must be "${id}"`); continue; }
    defs.push(d.value);
    const reposDir = join(dir, id, 'repos');
    if (!existsSync(reposDir)) continue;
    for (const f of readdirSync(reposDir).filter((n) => n.endsWith('.yaml')).sort()) {
      const rawRepo = read(join(reposDir, f));
      if (!rawRepo.ok) continue;
      const r = validateFactoryRepo(rawRepo.value, d.value);
      if (!r.ok) { bad(join(reposDir, f), r.error); continue; }
      if (`${r.value.repoId}.yaml` !== f) { bad(join(reposDir, f), `repoId must be "${f.slice(0, -5)}"`); continue; }
      repos.push(r.value);
    }
  }
  return { defs, repos };
}
