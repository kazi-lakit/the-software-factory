// Pure (no Node API): the browser entry validates factory definitions with it.
import { ChecksSchema, type Checks } from './checksSchema.js';

export interface FactoryDef {
  factoryId: string;
  name: string;
  protectedBranches: string[];
  gitName: string;
  gitEmail: string;
  docsPath: string;
  /** Keychain account of the factory's PAT (service `the-software-factory`). The Board stores the name, never a token. */
  patAccount: string;
  active: boolean;
  version: number;
}

export interface FactoryRepo {
  factoryId: string;
  repoId: string;
  remote: string;
  baseBranch: string;
  checks: Checks;
  version: number;
}

export interface FactoryHealth {
  factoryId: string;
  patPresent: boolean;
  checkedAt: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const ID_MAX = 40;
/** The settings scope of the whole Board; no factory may take it. */
export const RESERVED_ID = 'global';
export const isValidId = (v: unknown): v is string => typeof v === 'string' && v.length <= ID_MAX && ID_PATTERN.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Adds `main`, trims, drops blanks and duplicates. Order is kept. */
export function ensureMain(branches: string[]): string[] {
  const out: string[] = [];
  for (const b of [...branches, 'main']) {
    const name = b.trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

function text(input: Record<string, unknown>, key: string, fallback: string): string | null {
  const v = input[key];
  if (v === undefined || v === null) return fallback;
  return typeof v === 'string' ? v.trim() : null;
}

export function validateFactoryDef(input: unknown): Validated<FactoryDef> {
  if (!isObject(input)) return fail('factory must be an object');
  const { factoryId } = input;
  if (!isValidId(factoryId)) return fail(`factoryId must match ${ID_PATTERN.source} and be at most ${ID_MAX} characters`);
  if (factoryId === RESERVED_ID) return fail(`factory id ${RESERVED_ID} is reserved`);
  const name = text(input, 'name', factoryId);
  if (name === null) return fail('name must be text');
  if (name === '') return fail('name must not be blank');
  const gitName = text(input, 'gitName', '');
  const gitEmail = text(input, 'gitEmail', '');
  const docsPath = text(input, 'docsPath', '');
  const patAccount = text(input, 'patAccount', `github-pat:${factoryId}`);
  if (gitName === null || gitEmail === null || docsPath === null || patAccount === null) {
    return fail('gitName, gitEmail, docsPath and patAccount must be text');
  }
  if (gitEmail !== '' && !gitEmail.includes('@')) return fail('gitEmail must contain @');
  const rawBranches = input.protectedBranches ?? ['dev', 'stg', 'main'];
  if (!Array.isArray(rawBranches) || !rawBranches.every((b) => typeof b === 'string')) return fail('protectedBranches must be a list of branch names');
  const active = input.active ?? true;
  if (typeof active !== 'boolean') return fail('active must be true or false');
  const version = input.version ?? 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return fail('version must be a whole number');
  return {
    ok: true,
    value: {
      factoryId, name, protectedBranches: ensureMain(rawBranches as string[]), gitName, gitEmail, docsPath,
      patAccount: patAccount === '' ? `github-pat:${factoryId}` : patAccount, active, version,
    },
  };
}

export function validateFactoryRepo(input: unknown, def: FactoryDef): Validated<FactoryRepo> {
  if (!isObject(input)) return fail('repo must be an object');
  const { repoId } = input;
  if (!isValidId(repoId)) return fail(`repoId must match ${ID_PATTERN.source} and be at most ${ID_MAX} characters`);
  const remote = text(input, 'remote', '');
  if (remote === null || remote === '') return fail('remote must not be blank');
  const baseBranch = text(input, 'baseBranch', 'dev');
  if (baseBranch === null || baseBranch === '') return fail('baseBranch must not be blank');
  if (baseBranch === 'main' || baseBranch.replace(/^origin\//, '') === 'main') return fail('main is never a base');
  const parsed = ChecksSchema.safeParse(input.checks);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = ['checks', ...issue.path].join('.');
    return fail(`${path} ${issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message}`);
  }
  const version = input.version ?? 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return fail('version must be a whole number');
  return { ok: true, value: { factoryId: def.factoryId, repoId, remote, baseBranch, checks: parsed.data, version } };
}

/** Definitions held in memory. A definition that fails validation is left out and listed in `skipped()`. */
export class FactoryConfig {
  private readonly defs = new Map<string, FactoryDef>();
  private readonly byFactory = new Map<string, FactoryRepo[]>();
  private readonly skips: { id: string; reason: string }[] = [];

  constructor(defs: FactoryDef[], repos: FactoryRepo[]) {
    for (const d of defs) {
      const r = validateFactoryDef(d);
      if (!r.ok) this.skips.push({ id: String((d as { factoryId?: unknown } | null)?.factoryId ?? '?'), reason: r.error });
      else if (this.defs.has(r.value.factoryId)) this.skips.push({ id: r.value.factoryId, reason: 'duplicate factory id' });
      else this.defs.set(r.value.factoryId, { ...r.value, version: d.version });
    }
    for (const repo of repos) {
      const def = this.defs.get(repo.factoryId);
      const id = `${repo.factoryId}/${repo.repoId}`;
      if (!def) {
        this.skips.push({ id, reason: `factory ${repo.factoryId} is not available` });
        continue;
      }
      const r = validateFactoryRepo(repo, def);
      if (!r.ok) {
        this.skips.push({ id, reason: r.error });
        continue;
      }
      const list = this.byFactory.get(def.factoryId) ?? [];
      if (list.some((x) => x.repoId === repo.repoId)) {
        this.skips.push({ id, reason: 'duplicate repo id' });
        continue;
      }
      list.push(r.value);
      this.byFactory.set(def.factoryId, list);
    }
  }

  factories(): FactoryDef[] {
    return [...this.defs.values()];
  }
  factory(id: string): FactoryDef | undefined {
    return this.defs.get(id);
  }
  repo(factoryId: string, repoId: string): FactoryRepo | undefined {
    return this.byFactory.get(factoryId)?.find((r) => r.repoId === repoId);
  }
  repos(factoryId: string): FactoryRepo[] {
    return [...(this.byFactory.get(factoryId) ?? [])];
  }
  skipped(): { id: string; reason: string }[] {
    return [...this.skips];
  }
}
