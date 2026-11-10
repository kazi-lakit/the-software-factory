// Node-only: the one-time move to multiple factories (`factory migrate`). Every step checks before it acts, so a re-run is
// safe and a half-finished run resumes. The definition and settings writes are the owner's (see the CLI for how that is met).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonicalJson, type BoardStore, type StoredSettings } from './boardStore.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from './factories.js';
import { IMPORT_FORMAT, validateImportFile, type ImportFile } from './importFile.js';
import { loadRepoConfig } from './repoConfig.js';
import { ghLoggedInUsers, isGhLoggedIn, type ExecFile } from './secrets.js';

export const LEGACY_FACTORY_ID = 'blocks';

export interface MigrateStep {
  name: string;
  /** `already`: nothing to do (or done before). `now`: done by this run (with `dryRun`, would be). `skipped`: nothing to act on. `pending`: an owner step still to do (an import on the Board, or gh auth login). */
  done: 'already' | 'now' | 'skipped' | 'pending';
  detail: string;
}
export interface MigrateReport {
  steps: MigrateStep[];
  /** Things the owner should look at that no step changes (old-layout clones, legacy settings rows left). */
  notes: string[];
}
export interface MigrateOptions {
  dryRun?: boolean;
  /** Called as each step finishes, so a failure later still shows what was done. */
  onStep?: (s: MigrateStep) => void;
}

/** What the stored board looked like before this run wrote anything (a FileStore converts the old shape on load). */
function readLegacyFlags(root: string): { settings: boolean; untaggedTasks: number; untaggedEvents: number } {
  try {
    const raw = JSON.parse(readFileSync(join(root, '.factory', 'board.json'), 'utf8')) as Record<string, unknown>;
    const missing = (list: unknown) => (Array.isArray(list) ? list.filter((x) => (x as { factoryId?: unknown } | null)?.factoryId == null).length : 0);
    const settings = raw.settings as { global?: unknown } | null | undefined;
    return { settings: settings != null && typeof settings === 'object' && 'global' in settings, untaggedTasks: missing(raw.tasks), untaggedEvents: missing(raw.events) };
  } catch {
    return { settings: false, untaggedTasks: 0, untaggedEvents: 0 };
  }
}

const sorted = <T>(xs: T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

export const legacyDef = (home: string): FactoryDef => {
  const r = validateFactoryDef({
    factoryId: LEGACY_FACTORY_ID, name: 'Blocks', protectedBranches: ['dev', 'stg', 'main'], gitName: '', gitEmail: '',
    docsPath: join(home, 'scratchpad', 'selise', 'vaultS', 'projects'), ghUser: 'kazi-lakit', active: true,
  });
  if (!r.ok) throw new Error(`blocks definition: ${r.error}`);
  return r.value;
};

/** `<root>/repos/*.yaml` as repos of factory `blocks`; a file that does not load or validate stops the migration. */
function loadLegacyRepos(root: string, def: FactoryDef): FactoryRepo[] {
  const dir = join(root, 'repos');
  if (!existsSync(dir)) return [];
  const out: FactoryRepo[] = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.yaml')).sort()) {
    const repoId = basename(file, '.yaml');
    const cfg = loadRepoConfig(dir, repoId);
    const r = validateFactoryRepo({ repoId, remote: cfg.remote, baseBranch: cfg.baseBranch, checks: cfg.checks }, def);
    if (!r.ok) throw new Error(`repos/${file}: ${r.error}`);
    out.push(r.value);
  }
  return out;
}

/**
 * Step 4, read-only: is the gh login of `blocks` logged in? The stored definition's `ghUser` when it is on the Board, else
 * the one the import gives it. One `gh auth status`; no token is read.
 */
async function ghLoginStep(store: BoardStore, home: string, exec: ExecFile): Promise<MigrateStep> {
  const stored = (await store.listFactoryDefs()).find((d) => d.factoryId === LEGACY_FACTORY_ID);
  const valid = stored ? validateFactoryDef(stored) : undefined;
  const user = valid?.ok ? valid.value.ghUser : legacyDef(home).ghUser;
  return isGhLoggedIn(await ghLoggedInUsers(exec), user)
    ? { name: 'gh-login', done: 'already', detail: `gh account ${user} is logged in` }
    : { name: 'gh-login', done: 'pending', detail: `gh account ${user} is not logged in: run gh auth login` };
}

/** Repo ids that are missing from `have` or differ from `want` (remote, base branch, checks). */
function repoDiffs(have: FactoryRepo[], want: FactoryRepo[]): { missing: string[]; differ: string[] } {
  const missing: string[] = [];
  const differ: string[] = [];
  for (const r of want) {
    const got = have.find((x) => x.repoId === r.repoId);
    if (!got) missing.push(r.repoId);
    else if (got.remote !== r.remote || got.baseBranch !== r.baseBranch || canonicalJson(got.checks) !== canonicalJson(r.checks)) differ.push(r.repoId);
  }
  return { missing, differ };
}

/** Old-layout clones (`.clones/<repo>`, a clone itself) are not moved; the new layout is `.clones/<factory>/<repo>`. */
function oldLayoutNote(root: string): string | undefined {
  const clones = join(root, '.clones');
  if (!existsSync(clones)) return undefined;
  const old = sorted(readdirSync(clones, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'worktrees' && existsSync(join(clones, e.name, '.git'))), (e) => e.name);
  return old.length > 0 ? `old-layout clones not moved (a clone is made at .clones/<factory>/<repo> when needed): ${old.map((e) => `.clones/${e.name}`).join(', ')}` : undefined;
}

/**
 * Read-only: where each step stands (`already` or `pending`, `skipped` when there is nothing to act on). The gh login is
 * checked with `gh auth status`, never a token. `blocks: true` (the Blocks store) leaves out the file-store checks: the raw
 * board file and tag-tasks.
 */
export async function checkMigration(store: BoardStore, root: string, home: string, exec: ExecFile, opts: { blocks?: boolean } = {}): Promise<MigrateReport> {
  const steps: MigrateStep[] = [];
  const notes: string[] = [];
  const blocks = opts.blocks === true;
  const flags = blocks ? { settings: false, untaggedTasks: 0, untaggedEvents: 0 } : readLegacyFlags(root);
  const add = (name: string, done: MigrateStep['done'], detail: string) => steps.push({ name, done, detail });
  const ID = LEGACY_FACTORY_ID;
  const def = legacyDef(home);

  if (!(await store.listFactoryDefs()).some((d) => d.factoryId === ID)) {
    add('create-factory', 'pending', `${ID} factory not on the Board → import it on the Board (Settings → Factories → Import)`);
  } else {
    const d = repoDiffs(await store.listFactoryRepos(ID), loadLegacyRepos(root, def));
    if (d.missing.length + d.differ.length > 0) {
      const parts = [d.missing.length ? `missing: ${d.missing.join(', ')}` : '', d.differ.length ? `different from repos/*.yaml: ${d.differ.join(', ')}` : ''].filter(Boolean);
      add('create-factory', 'pending', `factory ${ID} is on the Board but its repos are incomplete (${parts.join('; ')}) → import it again on the Board`);
    } else {
      add('create-factory', 'already', `factory ${ID} and its repos exist`);
    }
  }

  if (!blocks) {
    const untagged = Math.max((await store.listTasks()).filter((t) => !t.factoryId).length, flags.untaggedTasks);
    if (untagged > 0) add('tag-tasks', 'pending', `${untagged} tasks without a factory`);
    else add('tag-tasks', 'already', 'every task has a factory');
  }

  const stored = (await store.getSettings()) as unknown as { global?: unknown; factories?: Record<string, unknown> };
  const legacy = await store.legacySettingsStatus();
  if ('global' in stored || flags.settings || legacy.unmoved.length > 0) add('move-settings', 'pending', `legacy settings not yet moved${legacy.unmoved.length ? ` (${legacy.unmoved.join(', ')})` : ''}`);
  else if (legacy.unretired.length > 0) add('move-settings', 'pending', `legacy settings rows not retired (${legacy.unretired.join(', ')})`);
  else if (stored.factories?.[ID]) add('move-settings', 'already', `settings are under ${ID}`);
  else add('move-settings', 'skipped', 'no settings stored');

  steps.push(await ghLoginStep(store, home, exec));

  const clones = oldLayoutNote(root);
  if (clones) notes.push(clones);
  return { steps, notes };
}

/** The import file for the Board: the `blocks` definition with the migrate defaults and the repos of `repos/*.yaml`. No secrets. */
export function buildImport(root: string, home: string): ImportFile {
  const factory = legacyDef(home);
  const r = validateImportFile({ format: IMPORT_FORMAT, factory, repos: loadLegacyRepos(root, factory) });
  if (!r.ok) throw new Error(`import file: ${r.error}`);
  return r.value;
}

/**
 * Moves today's work into factory `blocks` (the file store; on the Blocks store the owner imports on the Board instead).
 * Steps: 1 create `blocks` and its repos from `repos/*.yaml`; 2 tag tasks; 3 move the settings to the `blocks` scopes and
 * retire the legacy rows; 4 check, read-only, that the gh login of `blocks` is logged in; 5 read it all back; 6 tell the
 * owner to remove `repos/`. Nothing is deleted. Events cannot be rewritten through the store: the stores read an event
 * without a factoryId as `blocks`.
 */
export async function migrate(store: BoardStore, root: string, home: string, exec: ExecFile, opts: MigrateOptions = {}): Promise<MigrateReport> {
  const dry = opts.dryRun === true;
  const steps: MigrateStep[] = [];
  const notes: string[] = [];
  const push = (name: string, done: MigrateStep['done'], detail: string) => {
    const s = { name, done, detail };
    steps.push(s);
    opts.onStep?.(s);
  };
  const flags = readLegacyFlags(root);
  const would = dry ? 'would ' : '';

  // 1. The definition and its repos. The definition goes last: it is the "done" marker, so a run that stopped halfway resumes.
  const def = legacyDef(home);
  const defs = await store.listFactoryDefs();
  const repos = loadLegacyRepos(root, def);
  if (defs.some((d) => d.factoryId === LEGACY_FACTORY_ID)) {
    push('create-factory', 'already', `factory ${LEGACY_FACTORY_ID} exists`);
  } else {
    const have = new Set((await store.listFactoryRepos(LEGACY_FACTORY_ID)).map((r) => r.repoId));
    const add = repos.filter((r) => !have.has(r.repoId));
    if (!dry) {
      for (const r of add) await store.saveFactoryRepo(null, r);
      await store.saveFactoryDef(null, def);
    }
    push('create-factory', 'now', `${would}create ${LEGACY_FACTORY_ID} with ${repos.length} repos (${repos.map((r) => r.repoId).join(', ') || 'none'})`);
  }

  // 2. Tasks without a factory belong to `blocks`. A FileStore converts on load, so the raw file says how many there were.
  const untagged = (await store.listTasks()).filter((t) => !t.factoryId);
  if (!dry) for (const t of untagged) await store.updateTask(t.taskId, t.version, { factoryId: LEGACY_FACTORY_ID });
  const taskCount = Math.max(untagged.length, flags.untaggedTasks);
  if (taskCount > 0) {
    push('tag-tasks', 'now', `${would}tag ${taskCount} tasks as ${LEGACY_FACTORY_ID}; events without a factory are read as ${LEGACY_FACTORY_ID}`);
  } else if (flags.untaggedEvents > 0) {
    push('tag-tasks', 'now', `${would}save ${flags.untaggedEvents} events without a factory as ${LEGACY_FACTORY_ID}`);
  } else {
    push('tag-tasks', 'already', 'every task has a factory');
  }

  // 3. Settings: the old `global` and per-repo scopes become `blocks` and `blocks/<repo>`.
  const stored = (await store.getSettings()) as StoredSettings & { global?: typeof DEFAULT_SETTINGS; repos?: StoredSettings['factories'][string]['repos'] };
  const oldShape = 'global' in stored;
  const settings: StoredSettings = oldShape
    ? { factories: { [LEGACY_FACTORY_ID]: { factory: stored.global ?? structuredClone(DEFAULT_SETTINGS), repos: stored.repos ?? {} } } }
    : stored;
  const first = dry ? { retired: [] as string[], remaining: [] as string[] } : await store.retireLegacySettings();
  const needsMove = oldShape || flags.settings || first.remaining.length > 0;
  let retired = first.retired;
  let remaining = first.remaining;
  if (needsMove && !dry) {
    await store.setSettings(settings);
    const second = await store.retireLegacySettings();
    retired = [...new Set([...retired, ...second.retired])];
    remaining = second.remaining;
  }
  const blocksSettings = settings.factories[LEGACY_FACTORY_ID];
  if (remaining.length > 0) notes.push(`legacy settings rows not retired: ${remaining.join(', ')}`);
  if (needsMove || retired.length > 0) {
    push('move-settings', 'now', `${would}move settings to ${LEGACY_FACTORY_ID} scopes; retired legacy rows: ${retired.join(', ') || 'none'}`);
  } else if (blocksSettings) {
    push('move-settings', 'already', `settings are under ${LEGACY_FACTORY_ID}`);
  } else {
    push('move-settings', 'skipped', 'no settings stored');
  }

  // 4. The gh login of `blocks`: read-only, and a missing login is pending (the owner runs gh auth login), not a failure.
  const login = await ghLoginStep(store, home, exec);
  push(login.name, login.done, login.detail);

  // 5. Read back and compare with the source. Nothing is removed before this matches.
  const changed = steps.some((s) => s.done === 'now');
  if (dry) {
    push('read-back', 'skipped', 'dry run');
  } else {
    const bad: string[] = [];
    const nowDefs = await store.listFactoryDefs();
    const stored1 = nowDefs.find((d) => d.factoryId === LEGACY_FACTORY_ID);
    if (!stored1) bad.push(`factory ${LEGACY_FACTORY_ID} is missing`);
    const nowRepos = await store.listFactoryRepos(LEGACY_FACTORY_ID);
    const diffs = repoDiffs(nowRepos, repos);
    for (const id of diffs.missing) bad.push(`repo ${id} is missing`);
    for (const id of diffs.differ) bad.push(`repo ${id} differs from repos/${id}.yaml`);
    const left = (await store.listTasks()).filter((t) => !t.factoryId).length;
    if (left > 0) bad.push(`${left} tasks still have no factory`);
    if (blocksSettings) {
      const now = (await store.getSettings()).factories[LEGACY_FACTORY_ID];
      if (!now || canonicalJson(now) !== canonicalJson(blocksSettings)) bad.push(`settings of ${LEGACY_FACTORY_ID} differ from the source`);
    }
    if (bad.length > 0) throw new Error(`read-back failed: ${bad.join('; ')}`);
    push('read-back', changed ? 'now' : 'already', 'the Board copy matches the source');
  }

  // 6. repos/ is the owner's to remove.
  if (existsSync(join(root, 'repos'))) push('repos-folder', dry || changed ? 'now' : 'already', 'repos/ is no longer read; remove it with: git rm -r repos');
  else push('repos-folder', 'skipped', 'repos/ is not present');

  const clones = oldLayoutNote(root);
  if (clones) notes.push(clones);
  return { steps, notes };
}
