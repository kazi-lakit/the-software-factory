// Node-only: the one-time move to multiple factories (`factory migrate`). Every step checks before it acts, so a re-run is
// safe and a half-finished run resumes. The definition and settings writes are the owner's (see the CLI for how that is met).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonicalJson, type BoardStore, type StoredSettings } from './boardStore.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from './factories.js';
import { loadRepoConfig } from './repoConfig.js';
import { KEYCHAIN_SERVICE, readSecret, SecretMissingError, type ExecFile } from './secrets.js';

export const LEGACY_FACTORY_ID = 'blocks';
const SOURCE_ACCOUNT = 'github-pat';
const TARGET_ACCOUNT = `github-pat:${LEGACY_FACTORY_ID}`;

export interface MigrateStep {
  name: string;
  /** `already`: nothing to do (or done before). `now`: done by this run (with `dryRun`, would be). `skipped`: nothing to act on. */
  done: 'already' | 'now' | 'skipped';
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
function readLegacyFlags(root: string): { settings: boolean; untagged: boolean } {
  try {
    const raw = JSON.parse(readFileSync(join(root, '.factory', 'board.json'), 'utf8')) as Record<string, unknown>;
    const missing = (list: unknown) => Array.isArray(list) && list.some((x) => (x as { factoryId?: unknown } | null)?.factoryId == null);
    const settings = raw.settings as { global?: unknown } | null | undefined;
    return { settings: settings != null && typeof settings === 'object' && 'global' in settings, untagged: missing(raw.tasks) || missing(raw.events) };
  } catch {
    return { settings: false, untagged: false };
  }
}

const sorted = <T>(xs: T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

export const legacyDef = (home: string): FactoryDef => {
  const r = validateFactoryDef({
    factoryId: LEGACY_FACTORY_ID, name: 'Blocks', protectedBranches: ['dev', 'stg', 'main'], gitName: '', gitEmail: '',
    docsPath: join(home, 'scratchpad', 'selise', 'vaultS', 'projects'), patAccount: TARGET_ACCOUNT, active: true,
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

const quote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function hasEntry(exec: ExecFile, account: string): Promise<boolean> {
  // No -w: this only asks whether the entry exists, it never reads the value.
  return (await exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account])).code === 0;
}

/**
 * Moves today's work into factory `blocks`. Steps: 1 create `blocks` and its repos from `repos/*.yaml`; 2 tag tasks;
 * 3 move the settings to the `blocks` scopes and retire the legacy rows; 4 copy the Keychain PAT; 5 read it all back;
 * 6 tell the owner to remove `repos/`. Nothing is deleted. Events cannot be rewritten through the store: the stores
 * read an event without a factoryId as `blocks`.
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

  // 2. Tasks without a factory belong to `blocks`.
  const untagged = (await store.listTasks()).filter((t) => !t.factoryId);
  if (!dry) for (const t of untagged) await store.updateTask(t.taskId, t.version, { factoryId: LEGACY_FACTORY_ID });
  if (untagged.length > 0 || flags.untagged) {
    push('tag-tasks', 'now', `${would}tag ${untagged.length} tasks as ${LEGACY_FACTORY_ID}; events without a factory are read as ${LEGACY_FACTORY_ID}`);
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

  // 4. The Keychain PAT. The value only passes through memory and the child's stdin; it is never printed.
  let copied = false;
  if (await hasEntry(exec, TARGET_ACCOUNT)) {
    push('copy-pat', 'already', `${TARGET_ACCOUNT} exists in Keychain`);
  } else if (dry) {
    push('copy-pat', (await hasEntry(exec, SOURCE_ACCOUNT)) ? 'now' : 'skipped', `would copy ${SOURCE_ACCOUNT} to ${TARGET_ACCOUNT}`);
  } else {
    let pat: string | undefined;
    try {
      pat = await readSecret(SOURCE_ACCOUNT, exec);
    } catch (e) {
      if (!(e instanceof SecretMissingError)) throw e;
    }
    if (pat === undefined) {
      push('copy-pat', 'skipped', `${SOURCE_ACCOUNT} not in Keychain; add ${TARGET_ACCOUNT} by hand`);
    } else {
      if (/[\r\n]/.test(pat)) throw new Error(`${SOURCE_ACCOUNT} holds a line break; copy it to ${TARGET_ACCOUNT} by hand`);
      const { code } = await exec('security', ['-i'], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${TARGET_ACCOUNT} -w ${quote(pat)}\n`);
      if (code !== 0) throw new Error(`could not write ${TARGET_ACCOUNT} to Keychain`);
      copied = true;
      push('copy-pat', 'now', `copied ${SOURCE_ACCOUNT} to ${TARGET_ACCOUNT}`);
    }
  }

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
    for (const r of repos) {
      const got = nowRepos.find((x) => x.repoId === r.repoId);
      if (!got) bad.push(`repo ${r.repoId} is missing`);
      else if (got.remote !== r.remote || got.baseBranch !== r.baseBranch || canonicalJson(got.checks) !== canonicalJson(r.checks)) bad.push(`repo ${r.repoId} differs from repos/${r.repoId}.yaml`);
    }
    const left = (await store.listTasks()).filter((t) => !t.factoryId).length;
    if (left > 0) bad.push(`${left} tasks still have no factory`);
    if (blocksSettings) {
      const now = (await store.getSettings()).factories[LEGACY_FACTORY_ID];
      if (!now || canonicalJson(now) !== canonicalJson(blocksSettings)) bad.push(`settings of ${LEGACY_FACTORY_ID} differ from the source`);
    }
    if (copied) {
      const [a, b] = await Promise.all([readSecret(SOURCE_ACCOUNT, exec), readSecret(TARGET_ACCOUNT, exec)]).catch(() => [undefined, undefined]);
      if (a === undefined || a !== b) bad.push(`${TARGET_ACCOUNT} does not match ${SOURCE_ACCOUNT}`);
    }
    if (bad.length > 0) throw new Error(`read-back failed: ${bad.join('; ')}`);
    push('read-back', changed ? 'now' : 'already', 'the Board copy matches the source');
  }

  // 6. repos/ is the owner's to remove.
  if (existsSync(join(root, 'repos'))) push('repos-folder', dry || changed ? 'now' : 'already', 'repos/ is no longer read; remove it with: git rm -r repos');
  else push('repos-folder', 'skipped', 'repos/ is not present');

  // Old-layout clones (`.clones/<repo>`, a clone itself) are not moved; the new layout is `.clones/<factory>/<repo>`.
  const clones = join(root, '.clones');
  if (existsSync(clones)) {
    const old = sorted(readdirSync(clones, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'worktrees' && existsSync(join(clones, e.name, '.git'))), (e) => e.name);
    if (old.length > 0) notes.push(`old-layout clones not moved (a clone is made at .clones/<factory>/<repo> when needed): ${old.map((e) => `.clones/${e.name}`).join(', ')}`);
  }
  return { steps, notes };
}
