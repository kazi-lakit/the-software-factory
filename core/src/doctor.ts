import type { FactoryDef, FactoryHealth, FactoryRepo } from './factories.js';
import { githubConfigProblems } from './githubConfig.js';
import type { GitHubBoardFor, ProjectInfo } from './githubBoard.js';
import { GITHUB_SCHEMA_MISSING } from './githubSync.js';
import { parseRemote } from './remote.js';
import { isGhLoggedIn } from './secrets.js';
import { ALL_STATUSES } from './status.js';

/** The watcher counts as not seen after this long (builder's call 9). */
export const WATCHER_STALE_MS = 120_000;

export interface DoctorCheck { factoryId: string; check: string; ok: boolean; detail: string }

const TOKEN = /\b(?:gh[opsur]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g;
/** Replaces GitHub tokens in a message. */
export const redactSecrets = (s: string): string => s.replace(TOKEN, '[redacted]');
const firstLine = (e: unknown): string => redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Checks each factory's gh login and, with a `github` block, its GitHub setup. Reads only; a client error becomes a failing check. */
export async function doctor(o: {
  defs: FactoryDef[]; repos: FactoryRepo[]; store: 'file' | 'blocks'; loggedIn: ReadonlySet<string>; boardFor: GitHubBoardFor;
  /** Only these factories are checked; config problems are still found across all of them. */
  only?: string[];
  /** Blocks store: whether the GitHub tables exist, each factory's health, and the clock (the connected checks). */
  schemaReady?: boolean; health?: FactoryHealth[]; now?: Date;
}): Promise<DoctorCheck[]> {
  const problems = githubConfigProblems(o.defs, o.repos, o.store);
  const out: DoctorCheck[] = [];
  for (const def of o.defs.filter((d) => !o.only || o.only.includes(d.factoryId))) {
    const factoryId = def.factoryId;
    const add = (check: string, ok: boolean, detail: string): boolean => { out.push({ factoryId, check, ok, detail: redactSecrets(detail) }); return ok; };
    /** Runs a check; a thrown error fails it with the first line of the message. */
    const attempt = async <T>(check: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try { return await fn(); } catch (e) { add(check, false, firstLine(e)); return undefined; }
    };

    if (!isGhLoggedIn(o.loggedIn, def.ghUser)) {
      add('gh login', false, `${def.ghUser} is not logged in (run: gh auth login --hostname github.com)`);
      continue;
    }
    add('gh login', true, `${def.ghUser} logged in`);
    const github = def.github;
    if (!github) continue;

    const mine = problems.filter((p) => p.factoryId === factoryId);
    if (mine.length === 0) add('config', true, 'ok');
    for (const p of mine) add(p.repoId ? `config ${p.repoId}` : 'config', false, p.message);
    const connected = o.store === 'blocks' && github.mode === 'connected';
    if (connected) {
      if (o.schemaReady === false) add('github tables', false, GITHUB_SCHEMA_MISSING);
      else add('github tables', true, 'present');
    }

    const board = await attempt('scope', async () => o.boardFor(def.ghUser));
    if (!board) continue;
    const scopes = await attempt('scope', () => board.tokenScopes());
    const scopeOk = scopes !== undefined && (scopes === null
      ? add('scope', false, 'the gh login token has no OAuth scopes (fine-grained or app token); log in with gh auth login to get a token with the project scope')
      : scopes.includes('project')
        ? add('scope', true, 'project scope present')
        : add('scope', false, 'the gh login needs the project scope (run: gh auth refresh -s project)'));
    if (scopeOk) {
      const ref = github.project;
      const info: ProjectInfo | null | undefined = await attempt('project', () => board.project(ref));
      if (info === null) add('project', false, `project ${ref.owner}/${ref.number} not found or not visible to ${def.ghUser}`);
      else if (info) {
        add('project', true, `${ref.owner}/${ref.number} found`);
        const have = new Set(info.options.map((x) => x.name));
        const missing: string[] = [];
        for (const s of ALL_STATUSES) {
          const name = github.statusMap[s];
          if (!have.has(name) && !missing.includes(name)) missing.push(name);
        }
        if (missing.length === 0) add('status options', true, `all ${ALL_STATUSES.length} statuses map to existing options`);
        else add('status options', false, `missing on the Project: ${missing.join(', ')}`);
      }
    }
    for (const repo of o.repos.filter((r) => r.factoryId === factoryId).sort((a, b) => byId(a.repoId, b.repoId))) {
      let remote: { owner: string; repo: string };
      try { remote = parseRemote(repo.remote); } catch { continue; }
      const check = `label ${repo.repoId}`;
      if (github.label === '') { add(check, true, 'no label filter'); continue; }
      const exists = await attempt(check, () => board.labelExists(remote, github.label));
      if (exists !== undefined) add(check, true, exists ? 'exists' : 'missing; created on first push');
    }
    if (connected) {
      const seen = o.health?.find((h) => h.factoryId === factoryId)?.watcherSeenAt ?? null;
      const age = seen ? (o.now ?? new Date()).getTime() - Date.parse(seen) : Infinity;
      if (seen && age <= WATCHER_STALE_MS) add('watcher', true, `seen ${seen}`);
      else if (seen) add('watcher', false, `not seen since ${seen}; run factory sync --watch --store blocks`);
      else add('watcher', false, 'never seen; run factory sync --watch --store blocks');
    }
  }
  return out;
}
