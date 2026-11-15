// Node-only: the file-store layout (tests, smoke). The browser entry never imports this.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateFactoryRepo, type FactoryDef, type FactoryRepo } from './factories.js';
import { normaliseFactoryYaml } from './factoryYaml.js';
import type { Gate } from './types.js';

/** A file's compare-and-set version: the first 12 hex digits of its sha256, as an integer. */
export function yamlVersion(text: string): number {
  return Number.parseInt(createHash('sha256').update(text).digest('hex').slice(0, 12), 16);
}

export interface FactoryFileProblem { factoryId: string; file: string; reason: string }

export interface FactoryDirLoad {
  defs: FactoryDef[];
  repos: FactoryRepo[];
  /** The YAML gates per factory, for the factories whose YAML has them. */
  gates: Record<string, Partial<Record<Gate, boolean>>>;
  /** Every factory id with a factory.yaml that is not factory-app, valid or not: the YAML owns it, board.json does not. */
  owned: string[];
  problems: FactoryFileProblem[];
}

const APP_SKIP = 'factory.source factory-app: the YAML is a template for the Board; skipped';
const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a parsed (perhaps invalid) factory.yaml says it is an app-mode factory, in either shape. */
export function saysFactoryApp(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  if (isObject(raw.factory)) return raw.factory.source === 'factory-app';
  return isObject(raw.github) && raw.github.mode === 'connected';
}

/**
 * Reads `<dir>/<factoryId>/factory.yaml` (either shape, with `repos.list`) and the old `<dir>/<factoryId>/repos/<repoId>.yaml`.
 * Versions are content hashes of the file that holds each definition. A bad file throws with its path, or with `onSkip`
 * is skipped, reported and listed in `problems`. A factory-app file is skipped with a note. An absent `dir` is an empty tree.
 */
export function loadFactoriesFromDir(dir: string, onSkip?: (file: string, reason: string) => void): FactoryDirLoad {
  const out: FactoryDirLoad = { defs: [], repos: [], gates: {}, owned: [], problems: [] };
  const bad = (factoryId: string, file: string, reason: string): void => {
    if (!onSkip) throw new Error(`${file}: ${reason}`);
    out.problems.push({ factoryId, file, reason });
    onSkip(file, reason);
  };
  /** The file's text and parsed value; a file that cannot be read or parsed is as bad as one that fails validation. */
  const read = (factoryId: string, file: string): { text: string; value: unknown } | null => {
    try {
      const text = readFileSync(file, 'utf8');
      return { text, value: parse(text) };
    } catch (e) {
      if (!onSkip) throw e;
      bad(factoryId, file, e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  if (!existsSync(dir)) return out;
  for (const id of dirs(dir)) {
    const file = join(dir, id, 'factory.yaml');
    if (!existsSync(file)) continue;
    const parsed = read(id, file);
    if (parsed && saysFactoryApp(parsed.value)) { onSkip?.(file, APP_SKIP); continue; }
    out.owned.push(id);
    if (!parsed) continue;
    const y = normaliseFactoryYaml(parsed.value);
    if (!y.ok) { bad(id, file, y.error); continue; }
    const version = yamlVersion(parsed.text);
    const def = { ...y.value.def, version };
    if (def.factoryId !== id) { bad(id, file, `factoryId must be "${id}"`); continue; }
    out.defs.push(def);
    if (y.value.gates) out.gates[id] = y.value.gates;
    const listed = new Set(y.value.repos.map((r) => r.repoId));
    out.repos.push(...y.value.repos.map((r) => ({ ...r, version })));
    const reposDir = join(dir, id, 'repos');
    if (!existsSync(reposDir)) continue;
    for (const f of readdirSync(reposDir).filter((n) => n.endsWith('.yaml')).sort()) {
      const repoFile = join(reposDir, f);
      const rawRepo = read(id, repoFile);
      if (!rawRepo) continue;
      const r = validateFactoryRepo(rawRepo.value, def);
      if (!r.ok) { bad(id, repoFile, r.error); continue; }
      if (`${r.value.repoId}.yaml` !== f) { bad(id, repoFile, `repoId must be "${f.slice(0, -5)}"`); continue; }
      if (listed.has(r.value.repoId)) { bad(id, repoFile, `repo id ${r.value.repoId} is in repos.list and repos/${r.value.repoId}.yaml`); continue; }
      out.repos.push({ ...r.value, version: yamlVersion(rawRepo.text) });
    }
  }
  return out;
}
