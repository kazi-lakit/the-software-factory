import { VersionConflictError, type BoardStore } from './boardStore.js';
import { redactSecrets } from './doctor.js';
import type { FactoryDef, FactoryRepo } from './factories.js';
import type { GitHubFor } from './github.js';
import type { GitHubBoardFor, ProjectInfo } from './githubBoard.js';
import { githubConfigProblems, type GitHubSettings } from './githubConfig.js';
import { createdFromIssue, issueName, type NotApplied } from './githubPull.js';
import { applyPull, type PullError } from './githubPullApply.js';
import { GitHubPuller, type PullLock, type PullRelease } from './githubPuller.js';
import { projectKey } from './githubPush.js';
import { GitHubPusher, type PushResult } from './githubPusher.js';
import { failStaleSync, fitSyncPlan, latestSync, type SyncDone, type SyncRequest } from './githubSync.js';
import { isGhLoggedIn } from './secrets.js';
import { ALL_STATUSES } from './status.js';

// Connected mode, on the factory machine: pushes connected factories, plans the Board's sync requests, writes health.

/** How often the watcher writes each connected factory's health. */
export const WATCHER_HEALTH_MS = 30_000;

export interface WatcherDeps {
  store: BoardStore; boardFor: GitHubBoardFor; githubFor: GitHubFor; now: () => Date; claimant: string;
  /** The factory pull lock; when it also has `held` (the file lock), pushes wait while a plan holds it. */
  lock?: PullLock; loggedIn: () => Promise<ReadonlySet<string>>;
}
export interface SyncHandled { factoryId: string; requestId: string; state: 'planned' | 'failed'; actions: number; notApplied: number; error: string | null }
export interface WatchTick { schemaMissing: boolean; pushed: PushResult[]; synced: SyncHandled[]; superseded: string[] }

const SUPERSEDED = 'superseded by a newer Sync';
const noLock: PullLock = async () => () => undefined;
const firstLine = (e: unknown): string => redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
const older = (a: SyncRequest, b: SyncRequest): boolean => a.requestedAt < b.requestedAt || (a.requestedAt === b.requestedAt && a.requestId < b.requestId);

/** Project setup problems (builder's call 9): the Project not visible, or one per Status option the map names that it lacks. */
export function optionProblems(settings: GitHubSettings, info: ProjectInfo | null, ghUser: string): string[] {
  if (!info) return [`Project ${projectKey(settings.project)} not found or not visible to ${ghUser}`];
  const have = new Set(info.options.map((o) => o.name));
  const users = new Map<string, string[]>();
  for (const st of ALL_STATUSES) {
    const name = settings.statusMap[st];
    if (!have.has(name)) users.set(name, [...(users.get(name) ?? []), st]);
  }
  return [...users].map(([name, sts]) => `missing option "${name}" (used by ${sts.join(', ')})`);
}

export class GitHubWatcher {
  private readonly pusher: GitHubPusher;
  private readonly puller: GitHubPuller;
  private readonly lock: PullLock;
  private healthAt: number | null = null;

  constructor(private readonly d: WatcherDeps) {
    this.lock = d.lock ?? noLock;
    const held = (d.lock as { held?: (factoryId: string) => boolean } | undefined)?.held;
    this.pusher = new GitHubPusher({
      store: d.store, boardFor: d.boardFor, now: d.now, claimant: d.claimant, storeKind: 'blocks', ...(held ? { pullBusy: held } : {}),
    });
    this.puller = new GitHubPuller({ store: d.store, boardFor: d.boardFor, githubFor: d.githubFor, now: d.now, lock: this.lock });
  }

  /** One pass (builder's call 7): push, plan the newest request per factory, write health when due. Never throws for a GitHub error. */
  async tick(factoryIds?: string[]): Promise<WatchTick> {
    const out: WatchTick = { schemaMissing: false, pushed: [], synced: [], superseded: [] };
    const { store } = this.d;
    if (!(await store.githubSchemaReady())) return { ...out, schemaMissing: true };
    const defs = await store.listFactoryDefs();
    const repos = await store.listFactoryRepos();
    const connected = defs.filter((f) => f.github?.mode === 'connected' && (!factoryIds || factoryIds.includes(f.factoryId)))
      .sort((a, b) => a.factoryId.localeCompare(b.factoryId, undefined, { numeric: true }));
    if (connected.length === 0) return out;
    out.pushed = await this.pusher.pushAll(connected.map((f) => f.factoryId));
    for (const def of connected) await this.requests(def, defs, repos, out);
    await this.health(connected, defs, repos);
    return out;
  }

  /** The request step for one factory (see the brief's steps 1-9). */
  private async requests(def: FactoryDef, defs: FactoryDef[], repos: FactoryRepo[], out: WatchTick): Promise<void> {
    const { store, now } = this.d;
    const f = def.factoryId;
    let rows = await store.listSyncRequests(f);
    // A stale claim fails; a fresh one means the Board may be mid-apply, so nothing is planned for this factory.
    for (const r of rows.filter((x) => x.state === 'applying')) await failStaleSync(store, now, r);
    rows = await store.listSyncRequests(f);
    if (rows.some((r) => r.state === 'applying')) return;

    const target = latestSync(rows, 'queued');
    if (!target) return;
    for (const r of rows) {
      if (r === target || !((r.state === 'queued') || (r.state === 'planned' && older(r, target)))) continue;
      if (await this.saveRow(r, { ...r, state: 'failed', error: SUPERSEDED })) out.superseded.push(r.requestId);
    }

    let release: PullRelease | null = null;
    try {
      release = await this.lock(f);
      if (!release) return; // another plan holds it: the row stays queued for the next tick
      const handled = await this.plan(def, defs, repos, target, release);
      if (handled) out.synced.push(handled);
    } catch (e) {
      const error = firstLine(e);
      await this.saveRow(target, { ...target, state: 'failed', error });
      out.synced.push({ factoryId: f, requestId: target.requestId, state: 'failed', actions: 0, notApplied: 0, error });
    } finally {
      release?.();
    }
  }

  /** Plans one queued row under the lock; null when the lock was lost before anything was applied. */
  private async plan(def: FactoryDef, defs: FactoryDef[], repos: FactoryRepo[], target: SyncRequest, release: PullRelease): Promise<SyncHandled | null> {
    const { store, now } = this.d;
    const f = def.factoryId;
    const handled = (state: SyncHandled['state'], actions: number, notApplied: number, error: string | null): SyncHandled =>
      ({ factoryId: f, requestId: target.requestId, state, actions, notApplied, error });

    const { plan, errors } = await this.puller.planFactory(def, defs, repos, 'blocks', { pendingIssues: await this.pendingIssues(f) });
    if (!plan) {
      const error = errors[0]?.message ?? 'the Project could not be read';
      await this.saveRow(target, { ...target, state: 'failed', error });
      return handled('failed', 0, 0, error);
    }
    if (release.touch && !release.touch()) return null;

    // `block` is a core move: the factory machine applies it here, never the Board.
    const blocks = plan.actions.filter((a) => a.kind === 'block');
    const rest = plan.actions.filter((a) => a.kind !== 'block');
    const done: SyncDone[] = [];
    const allErrors: PullError[] = [...errors];
    const notApplied: NotApplied[] = [...plan.notApplied];
    if (blocks.length > 0) {
      const r = await applyPull(store, now, { factoryId: f, actions: blocks, notApplied: [] });
      done.push(...r.applied.map(({ taskId, issue, change }) => ({ taskId, issue, change })));
      notApplied.push(...r.notApplied);
      allErrors.push(...r.errors);
    }
    allErrors.push(...(await this.puller.saveNotAppliedLinks(def, plan.notApplied)));
    const fitted = fitSyncPlan({ actions: rest, notApplied, done, errors: allErrors });
    await this.saveRow(target, { ...target, state: 'planned', plan: fitted, plannedAt: now().toISOString() });
    return handled('planned', fitted.actions.length, fitted.notApplied.length, null);
  }

  /** Issues the Board will create or has created without the link yet: never planned again. */
  private async pendingIssues(factoryId: string): Promise<string[]> {
    const { store } = this.d;
    const links = new Map((await store.listGitHubLinks(factoryId)).map((l) => [l.taskId, l]));
    const unlinked = (await store.listTasks()).filter((t) => t.factoryId === factoryId && links.get(t.taskId)?.issueNumber == null);
    const out: string[] = [];
    for (const t of unlinked) {
      const from = createdFromIssue(await store.listEvents(t.taskId));
      if (from) out.push(issueName(from));
    }
    for (const r of await store.listSyncRequests(factoryId)) {
      if ((r.state !== 'planned' && r.state !== 'applying') || !r.plan) continue;
      for (const a of r.plan.actions) if (a.kind === 'create') out.push(issueName(a.issue));
    }
    return out;
  }

  /** Writes health for every connected factory when WATCHER_HEALTH_MS has passed since this watcher last did. */
  private async health(connected: FactoryDef[], defs: FactoryDef[], repos: FactoryRepo[]): Promise<void> {
    const { store, now } = this.d;
    const at = now();
    if (this.healthAt !== null && at.getTime() - this.healthAt < WATCHER_HEALTH_MS) return;
    const users = await this.d.loggedIn();
    const config = githubConfigProblems(defs, repos, 'blocks');
    for (const def of connected) {
      const settings = def.github!;
      const problems = [...new Set(config.filter((p) => p.factoryId === def.factoryId).map((p) => p.message))];
      try {
        problems.push(...optionProblems(settings, await this.d.boardFor(def.ghUser).project(settings.project), def.ghUser));
      } catch (e) {
        problems.push(firstLine(e));
      }
      const iso = at.toISOString();
      await store.setFactoryHealth({
        factoryId: def.factoryId, ghLoggedIn: isGhLoggedIn(users, def.ghUser), checkedAt: iso, watcherSeenAt: iso, githubProblems: problems,
      });
    }
    this.healthAt = at.getTime();
  }

  /** A row save; a conflict (another watcher or the Board moved it) is ignored and gives false. */
  private async saveRow(before: SyncRequest, after: SyncRequest): Promise<boolean> {
    try {
      await this.d.store.saveSyncRequest(before, after);
      return true;
    } catch (e) {
      if (e instanceof VersionConflictError) return false;
      throw e;
    }
  }
}
