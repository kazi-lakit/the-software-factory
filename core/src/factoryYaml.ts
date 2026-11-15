// Pure (no Node API): turns either factory.yaml shape (provider-neutral, or the legacy flat one) into the internal definitions.
import {
  RESERVED_ID, validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo,
} from './factories.js';
import { GATE_DOC } from './gates.js';
import { DEFAULT_LABEL, DEFAULT_STATUS_MAP, type GitHubSettings, type ProjectRef } from './githubConfig.js';
import type { Gate, Status } from './types.js';
import type { Validated } from './validated.js';

export type FactorySource = 'local' | 'factory-app';
export type BoardSource = 'none' | 'github' | 'trello' | 'jira' | 'factory-app';

export interface BoardConfig {
  source: BoardSource;
  mirror: 'none' | 'github';
  /** The GitHub Project; null when the factory does not use GitHub. */
  project: ProjectRef | null;
  label: string;
  approvers: string[];
  statusMap: Record<Status, string>;
}

/** One factory.yaml, normalised. `def.version` and each repo's `version` are 0: the loader sets them. */
export interface FactoryYaml {
  shape: 'new' | 'legacy';
  source: FactorySource;
  def: FactoryDef;
  repos: FactoryRepo[];
  /** The YAML's gates (local mode only); null when it has none or the factory is in an app mode. */
  gates: Partial<Record<Gate, boolean>> | null;
  /** Login per service, never a token. */
  accounts: Record<string, string>;
  board: BoardConfig;
}

const FACTORY_SOURCES: readonly FactorySource[] = ['local', 'factory-app'];
const BOARD_SOURCES: readonly BoardSource[] = ['none', 'github', 'trello', 'jira', 'factory-app'];
const RESERVED_BOARDS: readonly string[] = ['trello', 'jira'];
const MIRRORS = ['none', 'github'] as const;
const GATES = Object.keys(GATE_DOC) as Gate[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const given = (v: unknown): boolean => v !== undefined && v !== null;

/** Where each internal definition field lives in the new shape. */
const DEF_PATHS: Record<string, string> = {
  factoryId: 'factory.id', name: 'factory.name', gitName: 'factory.git.name', gitEmail: 'factory.git.email', docsPath: 'factory.docsPath',
  ghUser: 'accounts.github', active: 'factory.active', agentModels: 'factory.agents', protectedBranches: 'repos.protectedBranches',
  github: 'board', version: 'factory.version',
};
const repoPaths = (prefix: string): Record<string, string> => ({
  repoId: `${prefix}id`, remote: `${prefix}remote`, baseBranch: `${prefix}baseBranch`, checks: `${prefix}checks`,
  protectedBranches: `${prefix}protectedBranches`, version: `${prefix}version`,
});

/** Rewrites an internal error (`field.sub message`) as `<yaml.path>: message`; an error it cannot place is kept as it is. */
function located(error: string, paths: Record<string, string>): string {
  const m = /^(\w+)((?:\.[\w-]+)*):? (.*)$/.exec(error);
  if (!m || !Object.hasOwn(paths, m[1]!)) return error;
  return `${paths[m[1]!]}${m[2]}: ${m[3]}`;
}

/** An optional object at `path`; undefined when absent. */
function objectAt(parent: Record<string, unknown>, key: string, path: string): Validated<Record<string, unknown> | undefined> {
  const v = parent[key];
  if (!given(v)) return { ok: true, value: undefined };
  return isObject(v) ? { ok: true, value: v } : fail(`${path}: must be an object`);
}

/** An optional choice at `path`, `fallback` when absent. */
function choiceAt<T extends string>(v: unknown, path: string, choices: readonly T[], fallback: T): Validated<T> {
  if (!given(v)) return { ok: true, value: fallback };
  return (choices as readonly unknown[]).includes(v) ? { ok: true, value: v as T } : fail(`${path}: must be one of ${choices.join(', ')}`);
}

/** A repo host: only github in v1. */
function hostAt(v: unknown, path: string): Validated<'github'> {
  if (!given(v) || v === 'github') return { ok: true, value: 'github' };
  return typeof v === 'string' ? fail(`${path}: ${v} is not supported yet`) : fail(`${path}: must be text`);
}

function accountsOf(v: unknown): Validated<Record<string, string>> {
  if (!given(v)) return { ok: true, value: {} };
  if (!isObject(v)) return fail('accounts: must map services to logins');
  const out: Record<string, string> = {};
  for (const [k, login] of Object.entries(v)) {
    if (typeof login !== 'string') return fail(`accounts.${k}: must be text`);
    if (login.trim() !== '') out[k] = login.trim();
  }
  return { ok: true, value: out };
}

function gatesOf(v: unknown): Validated<Partial<Record<Gate, boolean>> | null> {
  if (!given(v)) return { ok: true, value: null };
  if (!isObject(v)) return fail('gates: must map gates to true or false');
  const out: Partial<Record<Gate, boolean>> = {};
  for (const [k, on] of Object.entries(v)) {
    if (!(GATES as string[]).includes(k)) return fail(`gates: has an unknown gate: ${k}`);
    if (typeof on !== 'boolean') return fail(`gates.${k}: must be true or false`);
    out[k as Gate] = on;
  }
  return { ok: true, value: out };
}

/** The board as the factory sees it; the GitHub fields come from the validated github block when there is one. */
function boardOf(source: BoardSource, mirror: 'none' | 'github', github: GitHubSettings | undefined): BoardConfig {
  if (!github) return { source, mirror, project: null, label: DEFAULT_LABEL, approvers: [], statusMap: { ...DEFAULT_STATUS_MAP } };
  const { project, label, approvers, statusMap } = github;
  return { source, mirror, project, label, approvers, statusMap };
}

/** The legacy flat shape: validated as today, then mapped. Repos live in `repos/*.yaml` and are not read here. */
function fromLegacy(raw: unknown): Validated<FactoryYaml> {
  const d = validateFactoryDef(raw);
  if (!d.ok) return d;
  const def = { ...d.value, version: 0 };
  const connected = def.github?.mode === 'connected';
  const rawGhUser = (raw as Record<string, unknown>).ghUser;
  return {
    ok: true,
    value: {
      shape: 'legacy', source: connected ? 'factory-app' : 'local', def, repos: [], gates: null,
      accounts: typeof rawGhUser === 'string' && rawGhUser.trim() !== '' ? { github: def.ghUser } : {},
      board: def.github ? boardOf(connected ? 'factory-app' : 'github', connected ? 'github' : 'none', def.github) : boardOf('none', 'none', undefined),
    },
  };
}

/** Board and factory sources must fit together (design section 5). */
function sourcesFit(source: FactorySource, board: BoardSource, mirror: 'none' | 'github'): string | null {
  if (RESERVED_BOARDS.includes(board)) return `board.source: ${board} is not supported yet`;
  if (board === 'factory-app' && source !== 'factory-app') return 'board.source: factory-app needs factory.source factory-app';
  if (board === 'github' && source !== 'local') return 'board.source: github needs factory.source local';
  if (mirror !== 'none' && board !== 'factory-app') return `board.mirror: ${mirror} needs board.source factory-app`;
  return null;
}

function fromNew(raw: Record<string, unknown>, factory: Record<string, unknown>): Validated<FactoryYaml> {
  const boardAt = objectAt(raw, 'board', 'board');
  if (!boardAt.ok) return boardAt;
  const reposAt = objectAt(raw, 'repos', 'repos');
  if (!reposAt.ok) return reposAt;
  const gitAt = objectAt(factory, 'git', 'factory.git');
  if (!gitAt.ok) return gitAt;
  const [board, repos, git] = [boardAt.value ?? {}, reposAt.value ?? {}, gitAt.value ?? {}];
  const accounts = accountsOf(raw.accounts);
  if (!accounts.ok) return accounts;
  const source = choiceAt(factory.source, 'factory.source', FACTORY_SOURCES, 'local');
  if (!source.ok) return source;
  const boardSource = choiceAt(board.source, 'board.source', BOARD_SOURCES, 'none');
  if (!boardSource.ok) return boardSource;
  const mirror = choiceAt(board.mirror, 'board.mirror', MIRRORS, 'none');
  if (!mirror.ok) return mirror;
  const misfit = sourcesFit(source.value, boardSource.value, mirror.value);
  if (misfit) return fail(misfit);

  const host = hostAt(repos.host, 'repos.host');
  if (!host.ok) return host;
  const list = repos.list ?? [];
  if (!Array.isArray(list)) return fail('repos.list: must be a list of repos');
  for (const [i, e] of list.entries()) {
    if (!isObject(e)) return fail(`repos.list[${i}]: must be an object`);
    const h = hostAt(e.host, `repos.list[${i}].host`);
    if (!h.ok) return h;
  }
  const gates = source.value === 'local' ? gatesOf(raw.gates) : { ok: true as const, value: null };
  if (!gates.ok) return gates;

  // Every repo host is github in v1, so any repo uses the github account.
  const usedBy = [boardSource.value === 'github' && 'board', mirror.value === 'github' && 'board.mirror', list.length > 0 && 'repos']
    .filter((x): x is string => typeof x === 'string');
  if (usedBy.length > 0 && accounts.value.github === undefined) return fail(`accounts.github is required (used by: ${usedBy.join(', ')})`);

  const mode = boardSource.value === 'github' ? 'github-only' : mirror.value === 'github' ? 'connected' : null;
  const github = mode && {
    mode, project: board.project, label: board.label, approvers: board.approvers, statusMap: board.statusMap ?? DEFAULT_STATUS_MAP,
  };
  const d = validateFactoryDef({
    factoryId: factory.id, name: factory.name, gitName: git.name, gitEmail: git.email, docsPath: factory.docsPath,
    ghUser: accounts.value.github, active: factory.active, agentModels: factory.agents, protectedBranches: repos.protectedBranches,
    ...(github ? { github } : {}), version: 0,
  });
  if (!d.ok) return fail(textError(d.error, factory, git) ?? located(d.error, DEF_PATHS));
  const def = d.value;

  const out: FactoryRepo[] = [];
  for (const [i, e] of (list as Record<string, unknown>[]).entries()) {
    const prefix = `repos.list[${i}].`;
    const r = validateFactoryRepo({
      repoId: e.id, remote: e.remote, baseBranch: e.baseBranch, checks: e.checks, protectedBranches: e.protectedBranches, version: 0,
    }, def);
    if (!r.ok) return fail(r.error === 'main is never a base' ? `${prefix}baseBranch: ${r.error}` : located(r.error, repoPaths(prefix)));
    if (out.some((x) => x.repoId === r.value.repoId)) return fail(`${prefix}id: duplicate repo id ${r.value.repoId}`);
    out.push(r.value);
  }
  return {
    ok: true,
    value: {
      shape: 'new', source: source.value, def, repos: out, gates: gates.value, accounts: accounts.value,
      board: boardOf(boardSource.value, mirror.value, def.github),
    },
  };
}

/** Errors the internal validator reports for several fields at once, placed on the one field that caused them. */
function textError(error: string, factory: Record<string, unknown>, git: Record<string, unknown>): string | null {
  if (error === `factory id ${RESERVED_ID} is reserved`) return `factory.id: ${RESERVED_ID} is reserved`;
  if (!error.endsWith('must be text')) return null;
  const fields: [unknown, string][] = [[factory.name, 'factory.name'], [factory.docsPath, 'factory.docsPath'], [git.name, 'factory.git.name'], [git.email, 'factory.git.email']];
  const bad = fields.find(([v]) => given(v) && typeof v !== 'string');
  return bad ? `${bad[1]}: must be text` : null;
}

/**
 * Normalises a parsed factory.yaml. A top-level `factory` object means the new shape; anything else is read as the
 * legacy flat shape. New-shape errors read `<yaml.path>: <message>`; legacy errors read as they always have.
 */
export function normaliseFactoryYaml(raw: unknown): Validated<FactoryYaml> {
  if (isObject(raw) && isObject(raw.factory)) return fromNew(raw, raw.factory);
  return fromLegacy(raw);
}
