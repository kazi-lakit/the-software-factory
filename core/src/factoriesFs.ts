// Node-only: the file-store layout (tests, smoke). The browser entry never imports this.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from './factories.js';

const readYaml = (file: string): unknown => parse(readFileSync(file, 'utf8'));
const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

/**
 * Reads `<dir>/<factoryId>/factory.yaml` and `<dir>/<factoryId>/repos/<repoId>.yaml`. Files that fail validation throw
 * with the file path; an absent `dir` is an empty tree.
 */
export function loadFactoriesFromDir(dir: string): { defs: FactoryDef[]; repos: FactoryRepo[] } {
  const defs: FactoryDef[] = [];
  const repos: FactoryRepo[] = [];
  if (!existsSync(dir)) return { defs, repos };
  for (const id of dirs(dir)) {
    const file = join(dir, id, 'factory.yaml');
    if (!existsSync(file)) continue;
    const d = validateFactoryDef(readYaml(file));
    if (!d.ok) throw new Error(`${file}: ${d.error}`);
    if (d.value.factoryId !== id) throw new Error(`${file}: factoryId must be "${id}"`);
    defs.push(d.value);
    const reposDir = join(dir, id, 'repos');
    if (!existsSync(reposDir)) continue;
    for (const f of readdirSync(reposDir).filter((n) => n.endsWith('.yaml')).sort()) {
      const r = validateFactoryRepo(readYaml(join(reposDir, f)), d.value);
      if (!r.ok) throw new Error(`${join(reposDir, f)}: ${r.error}`);
      if (`${r.value.repoId}.yaml` !== f) throw new Error(`${join(reposDir, f)}: repoId must be "${f.slice(0, -5)}"`);
      repos.push(r.value);
    }
  }
  return { defs, repos };
}
