import type { BoardStore } from './boardStore.js';
import { VersionConflictError } from './boardStore.js';
import { redactSecrets } from './doctor.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { resolveGates, resolveSettings } from './gates.js';
import type { GitHubBoard, GitHubBoardFor, ProjectInfo, RepoRef } from './githubBoard.js';
import type { GitHubSettings } from './githubConfig.js';
import { emptyPushed, type GitHubLink } from './githubLink.js';
import { blockedKey, bodyHash, planPush, projectKey, type PushAction } from './githubPush.js';
import { githubConfigProblems } from './githubConfig.js';
import { parseRemote } from './remote.js';
import type { Task } from './types.js';

// Runs the planned GitHub actions for a task: one pusher per task at a time (lease), progress saved after each action, backoff on failure.

export interface PushResult {
  taskId: string;
  /** "owner/repo#n" once the issue exists. */
  issue: string | null;
  /** One short phrase per action taken, e.g. "created", "status Todo", "spec v2 comment", "closed". */
  done: string[];
  error: string | null;
  skipped: 'not-github' | 'leased' | 'backoff' | null;
}
export interface PusherDeps { store: BoardStore; boardFor: GitHubBoardFor; now: () => Date; claimant: string }

export const LEASE_MS = 60_000;
export const backoffMs = (attempts: number): number => Math.min(5_000 * 2 ** (attempts - 1), 600_000);

type ProjectCache = Map<string, ProjectInfo | null>;

const numericId = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);

function phrase(a: PushAction): string | null {
  switch (a.kind) {
    case 'create': return 'created';
    case 'addToProject': return null;
    case 'setStatus': return `status ${a.option}`;
    case 'addLabel': return `label ${a.label}`;
    case 'updateIssue': return 'title/body';
    case 'comment': return a.about === 'blocked' ? 'blocked comment' : `${a.about} v${a.version} comment`;
    case 'close': return 'closed';
  }
}

export class GitHubPusher {
  constructor(private readonly d: PusherDeps) {}

  pushTask(taskId: string, opts: { ignoreBackoff?: boolean } = {}): Promise<PushResult> {
    return this.push(taskId, opts, new Map());
  }

  /** Every task of every github-only factory (or only `factoryIds`), one at a time, by task id. */
  async pushAll(factoryIds?: string[], opts: { ignoreBackoff?: boolean } = {}): Promise<PushResult[]> {
    const defs = await this.d.store.listFactoryDefs();
    const ids = new Set(defs.filter((f) => f.github?.mode === 'github-only' && (!factoryIds || factoryIds.includes(f.factoryId))).map((f) => f.factoryId));
    const tasks = (await this.d.store.listTasks()).filter((t) => ids.has(t.factoryId)).sort((a, b) => numericId(a.taskId) - numericId(b.taskId));
    const cache: ProjectCache = new Map();
    const out: PushResult[] = [];
    for (const t of tasks) {
      try {
        out.push(await this.push(t.taskId, opts, cache));
      } catch (e) {
        out.push({ taskId: t.taskId, issue: null, done: [], error: this.firstLine(e), skipped: null });
      }
    }
    return out;
  }

  private firstLine(e: unknown): string {
    return redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
  }

  private async push(taskId: string, opts: { ignoreBackoff?: boolean }, cache: ProjectCache): Promise<PushResult> {
    const { store } = this.d;
    const now = this.d.now();
    const result: PushResult = { taskId, issue: null, done: [], error: null, skipped: null };
    const task = await store.getTask(taskId);
    const def = (await store.listFactoryDefs()).find((f) => f.factoryId === task.factoryId);
    const settings = def?.github;
    if (!def || !settings || settings.mode !== 'github-only') return { ...result, skipped: 'not-github' };
    const link = await store.getGitHubLink(taskId);
    if (link) result.issue = this.issueName(link);
    if (link?.error && !opts.ignoreBackoff && Date.parse(link.error.nextAttemptAt) > now.getTime()) return { ...result, skipped: 'backoff' };

    const factoryRepo = (await store.listFactoryRepos(task.factoryId)).find((r) => r.repoId === task.repo);
    if (!factoryRepo) return this.fail(link, task, '', `repo ${task.repo} is not configured for factory ${task.factoryId}`, result);
    let ref: RepoRef;
    try { ref = parseRemote(factoryRepo.remote); } catch (e) { return this.fail(link, task, '', this.firstLine(e), result); }
    const repoName = `${ref.owner}/${ref.repo}`;
    const defs = await store.listFactoryDefs();
    const problem = githubConfigProblems(defs, await store.listFactoryRepos(), 'file')
      .find((p) => (p.factoryId === task.factoryId && (p.repoId === undefined || p.repoId === task.repo))
        || p.message.includes(`already used by ${task.factoryId}/${task.repo};`)); // the first owner is blocked too: it is a clash
    if (problem) return this.fail(link, task, repoName, problem.message, result);

    const stored = (await store.getSettings()).factories[task.factoryId];
    const gates = resolveGates(resolveSettings(stored?.factory ?? DEFAULT_SETTINGS, stored?.repos[task.repo]), task.gateOverrides);
    const docs = { spec: await store.currentDoc(taskId, 'spec'), plan: await store.currentDoc(taskId, 'plan') };
    const actions = planPush({ task, link, settings, docs, gates });
    const key = blockedKey(task);
    if (actions.length === 0 && !link?.error && (link?.pushed.blocked ?? null) === key) return result;

    if (link?.lease && Date.parse(link.lease.until) > now.getTime()) return { ...result, skipped: 'leased' };
    const base: GitHubLink = link ?? {
      taskId, factoryId: task.factoryId, repo: repoName, issueNumber: null, issueNodeId: null, project: null, itemId: null,
      pushed: emptyPushed(), error: null, lease: null, reported: [], version: 0,
    };
    let cur: GitHubLink;
    try {
      cur = await store.saveGitHubLink(link ?? null, { ...base, lease: { by: this.d.claimant, until: new Date(now.getTime() + LEASE_MS).toISOString() } });
    } catch (e) {
      if (e instanceof VersionConflictError) return { ...result, skipped: 'leased' };
      throw e;
    }

    try {
      cur = await this.run(task, ref, settings, actions, cur, result, cache, (l) => { cur = l; });
      const pushed = { ...cur.pushed, blocked: key };
      cur = await store.saveGitHubLink(cur, { ...cur, pushed, error: null, lease: null });
      result.issue = this.issueName(cur);
      return result;
    } catch (e) {
      const message = this.firstLine(e);
      const attempts = (link?.error?.attempts ?? 0) + 1;
      result.error = message;
      try {
        const latest = cur;
        const failed = { message, attempts, nextAttemptAt: new Date(this.d.now().getTime() + backoffMs(attempts)).toISOString() };
        const saved = await store.saveGitHubLink(latest, { ...latest, error: failed, lease: null });
        result.issue = this.issueName(saved);
      } catch { /* a conflict means another pusher owns the link now; otherwise the lease expires by itself */ }
      return result;
    }
  }

  /** Records a failure that happens before any GitHub call (config problem): link error with backoff, lease respected. */
  private async fail(link: GitHubLink | undefined, task: Task, repo: string, message: string, result: PushResult): Promise<PushResult> {
    const now = this.d.now();
    if (link?.lease && Date.parse(link.lease.until) > now.getTime()) return { ...result, skipped: 'leased' };
    const attempts = (link?.error?.attempts ?? 0) + 1;
    const error = { message, attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)).toISOString() };
    const base: GitHubLink = link ?? {
      taskId: task.taskId, factoryId: task.factoryId, repo, issueNumber: null, issueNodeId: null, project: null, itemId: null,
      pushed: emptyPushed(), error: null, lease: null, reported: [], version: 0,
    };
    try {
      await this.d.store.saveGitHubLink(link ?? null, { ...base, error, lease: null });
    } catch (e) {
      if (e instanceof VersionConflictError) return { ...result, skipped: 'leased' };
      throw e;
    }
    return { ...result, error: message };
  }

  private issueName(l: GitHubLink): string | null {
    return l.issueNumber == null ? null : `${l.repo}#${l.issueNumber}`;
  }

  private async run(task: Task, ref: RepoRef, settings: GitHubSettings, actions: PushAction[], start: GitHubLink, result: PushResult, cache: ProjectCache, track: (l: GitHubLink) => void): Promise<GitHubLink> {
    if (actions.length === 0) return start;
    const def = (await this.d.store.listFactoryDefs()).find((f) => f.factoryId === task.factoryId)!;
    const board = this.d.boardFor(def.ghUser);
    let project: ProjectInfo | undefined;
    if (actions.some((a) => a.kind === 'addToProject' || a.kind === 'setStatus')) project = await this.project(board, def.ghUser, settings, cache);
    let labelReady = false;
    const ensureLabel = async (): Promise<void> => {
      if (labelReady || settings.label === '') return;
      if (!(await board.labelExists(ref, settings.label))) await board.createLabel(ref, settings.label);
      labelReady = true;
    };
    let cur = start;
    const save = async (patch: (l: GitHubLink) => GitHubLink): Promise<void> => {
      const next = patch(structuredClone(cur));
      if (next.lease) next.lease = { ...next.lease, until: new Date(this.d.now().getTime() + LEASE_MS).toISOString() };
      cur = await this.d.store.saveGitHubLink(cur, next);
      track(cur);
    };
    for (const a of actions) {
      switch (a.kind) {
        case 'create': {
          await ensureLabel();
          const made = await board.createIssue(ref, { title: a.title, body: a.body, labels: a.labels });
          const label = settings.label === '' ? null : settings.label;
          await save((l) => ({ ...l, issueNumber: made.number, issueNodeId: made.nodeId, pushed: { ...l.pushed, title: a.title, bodyHash: bodyHash(task.description), label } }));
          break;
        }
        case 'addToProject': {
          const itemId = await board.addToProject(project!, cur.issueNodeId!);
          await save((l) => ({ ...l, itemId, project: projectKey(settings.project) }));
          break;
        }
        case 'setStatus':
          await board.setStatus(project!, cur.itemId!, a.option);
          await save((l) => ({ ...l, pushed: { ...l.pushed, status: task.status, option: a.option } }));
          break;
        case 'addLabel':
          await ensureLabel();
          await board.addLabels(ref, cur.issueNumber!, [a.label]);
          await save((l) => ({ ...l, pushed: { ...l.pushed, label: a.label } }));
          break;
        case 'updateIssue':
          await board.updateIssue(ref, cur.issueNumber!, { title: a.title, body: a.body });
          await save((l) => ({ ...l, pushed: { ...l.pushed, title: a.title, bodyHash: bodyHash(task.description) } }));
          break;
        case 'comment':
          await board.addComment(ref, cur.issueNumber!, a.body);
          if (a.about === 'blocked') await save((l) => ({ ...l, pushed: { ...l.pushed, blocked: a.key } }));
          else await save((l) => ({ ...l, pushed: { ...l.pushed, docs: { ...l.pushed.docs, [a.about]: a.version } } }));
          break;
        case 'close':
          await board.closeIssue(ref, cur.issueNumber!, a.reason);
          await save((l) => ({ ...l, pushed: { ...l.pushed, closed: true, status: task.status } }));
          break;
      }
      const p = phrase(a);
      if (p) result.done.push(p);
    }
    return cur;
  }

  private async project(board: GitHubBoard, ghUser: string, s: GitHubSettings, cache: ProjectCache): Promise<ProjectInfo> {
    const k = `${ghUser}|${projectKey(s.project)}`;
    if (!cache.has(k)) cache.set(k, await board.project(s.project));
    const p = cache.get(k);
    if (!p) throw new Error(`Project ${s.project.owner}/${s.project.number} not found`);
    return p;
  }
}
