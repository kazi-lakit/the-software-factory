import { VersionConflictError, type BoardStore } from './boardStore.js';
import { redactSecrets } from './doctor.js';
import type { FactoryDef, FactoryRepo } from './factories.js';
import type { GitHubFor } from './github.js';
import type { GitHubBoard, GitHubBoardFor, ProjectItem, RepoRef } from './githubBoard.js';
import { githubConfigProblems } from './githubConfig.js';
import { emptyPushed, type GitHubLink, type PushedState } from './githubLink.js';
import { issueName, planPull, pullNeeds, type PullInput, type PullPlan, type PullTaskView } from './githubPull.js';
import { applyPull, type ApplyResult } from './githubPullApply.js';
import { projectKey } from './githubPush.js';
import { parseRemote } from './remote.js';
import type { Task } from './types.js';

// Node side of pull: reads GitHub, runs the pure planner and applier, saves the link records, and reacts to the comments it used.

export interface PullResult extends ApplyResult { factoryId: string; skipped: 'busy' | null }
/** Takes the factory's pull lock: a release function, or null when another pull holds it. */
export type PullLock = (factoryId: string) => Promise<(() => void) | null>;
export interface PullerDeps { store: BoardStore; boardFor: GitHubBoardFor; githubFor: GitHubFor; now: () => Date; lock?: PullLock }

type Fail = (taskId: string | null, issue: string | null, e: unknown, prefix?: string) => void;

const REPORTED_MAX = 20;
const WITH_DOCS = new Set(['spec_review', 'plan_review', 'pr_open', 'blocked']);
const noLock: PullLock = async () => () => undefined;
const empty = (factoryId: string, skipped: PullResult['skipped'] = null): PullResult => ({ factoryId, created: [], applied: [], notApplied: [], errors: [], skipped });
const slugOf = (r: FactoryRepo): string => { const { owner, repo } = parseRemote(r.remote); return `${owner}/${repo}`; };
const refOfName = (name: string): RepoRef => { const [owner, repo] = name.replace(/#\d+$/, '').split('/'); return { owner: owner!, repo: repo! }; };

export class GitHubPuller {
  constructor(private readonly d: PullerDeps) {}

  /** Every github-only factory (or only `factoryIds`), by factory id. Never throws for a GitHub error. */
  async pull(factoryIds?: string[]): Promise<PullResult[]> {
    const { store } = this.d;
    const defs = await store.listFactoryDefs();
    const repos = await store.listFactoryRepos();
    const picked = defs.filter((f) => f.github?.mode === 'github-only' && (!factoryIds || factoryIds.includes(f.factoryId)))
      .sort((a, b) => a.factoryId.localeCompare(b.factoryId, undefined, { numeric: true }));
    const out: PullResult[] = [];
    for (const def of picked) {
      let release: (() => void) | null = null;
      try {
        release = await (this.d.lock ?? noLock)(def.factoryId);
        if (!release) { out.push(empty(def.factoryId, 'busy')); continue; }
        out.push(await this.pullFactory(def, defs, repos));
      } catch (e) {
        out.push({ ...empty(def.factoryId), errors: [{ taskId: null, issue: null, message: this.firstLine(e) }] });
      } finally {
        release?.();
      }
    }
    return out;
  }

  private firstLine(e: unknown): string {
    return redactSecrets((e instanceof Error ? e.message : String(e)).split('\n')[0]!);
  }

  private async pullFactory(def: FactoryDef, defs: FactoryDef[], allRepos: FactoryRepo[]): Promise<PullResult> {
    const { store } = this.d;
    const settings = def.github!;
    const result = empty(def.factoryId);
    const fail: Fail = (taskId, issue, e, prefix = '') => { result.errors.push({ taskId, issue, message: prefix + this.firstLine(e) }); };
    const problem = githubConfigProblems(defs, allRepos, 'file').find((p) => p.factoryId === def.factoryId);
    if (problem) { fail(null, null, problem.message); return result; }

    const board = this.d.boardFor(def.ghUser);
    let items: ProjectItem[];
    try {
      const project = await board.project(settings.project);
      if (!project) { fail(null, null, `Project ${projectKey(settings.project)} not found`); return result; }
      items = await board.listItems(project);
    } catch (e) { fail(null, null, e); return result; }

    const mine = allRepos.filter((r) => r.factoryId === def.factoryId);
    const links = new Map((await store.listGitHubLinks(def.factoryId)).map((l) => [l.taskId, l]));
    const tasks = (await store.listTasks()).filter((t) => t.factoryId === def.factoryId);
    const linked = tasks.filter((t) => links.get(t.taskId)?.issueNumber != null);
    const input: PullInput = {
      factoryId: def.factoryId, settings,
      repos: mine.map((r) => ({ repoId: r.repoId, slug: slugOf(r), baseBranch: r.baseBranch })),
      otherRepos: allRepos.filter((r) => r.factoryId !== def.factoryId).map(slugOf),
      items, tasks: await Promise.all(linked.map((t) => this.view(t, links.get(t.taskId)!))),
      unlinked: tasks.filter((t) => links.get(t.taskId)?.issueNumber == null).map((t) => t.taskId),
    };

    await this.fetchNeeds(input, def, board, fail);
    const plan: PullPlan = planPull(input);
    const applied = await applyPull(store, this.d.now, plan);
    result.created = applied.created;
    result.applied = applied.applied;
    result.notApplied = applied.notApplied;
    result.errors.push(...applied.errors);
    await this.saveLinks(def, applied, fail);
    for (const a of applied.applied) {
      if (a.commentId === null) continue;
      try { await board.reactToComment(refOfName(a.issue), a.commentId, '+1'); } catch (e) { fail(a.taskId, a.issue, e, 'reaction failed: '); }
    }
    return result;
  }

  private async view(task: Task, link: GitHubLink): Promise<PullTaskView> {
    const { store } = this.d;
    if (!WITH_DOCS.has(task.status)) return { task, link, docs: {}, approvals: [] };
    const docs: PullTaskView['docs'] = {};
    for (const k of ['spec', 'plan', 'review'] as const) {
      const doc = await store.currentDoc(task.taskId, k);
      if (doc) docs[k] = doc.version;
    }
    return { task, link, docs, approvals: await store.listApprovals(task.taskId) };
  }

  /** Fills each view with what `pullNeeds` names; a failed read is an error for that task and the view goes without it. */
  private async fetchNeeds(input: PullInput, def: FactoryDef, board: GitHubBoard, fail: Fail): Promise<void> {
    const needs = pullNeeds(input);
    const client = this.d.githubFor(def.ghUser);
    const viewOf = (id: string): PullTaskView => input.tasks.find((v) => v.task.taskId === id)!;
    const where = (v: PullTaskView): string => issueName({ repo: v.link.repo, number: v.link.issueNumber! });
    for (const n of needs.comments) {
      const v = viewOf(n.taskId);
      try { v.comments = await board.listComments(refOfName(v.link.repo), v.link.issueNumber!, n.since); } catch (e) { fail(n.taskId, where(v), e); }
    }
    for (const n of needs.reviews) {
      const v = viewOf(n.taskId);
      try { v.reviews = await client.prReviews(n.prUrl); } catch (e) { fail(n.taskId, where(v), e); }
    }
    for (const n of needs.prStates) {
      const v = viewOf(n.taskId);
      try { v.prState = await client.prState(n.prUrl); } catch (e) { fail(n.taskId, where(v), e); }
    }
  }

  /** Saves the link of each created task and the patches of applied and not-applied items; one re-read and retry on a conflict. */
  private async saveLinks(def: FactoryDef, r: ApplyResult, fail: Fail): Promise<void> {
    const settings = def.github!;
    type Step = (l: GitHubLink) => GitHubLink;
    const patches = new Map<string, { issue: string; steps: Step[]; create?: GitHubLink }>();
    const slot = (taskId: string, issue: string) => {
      if (!patches.has(taskId)) patches.set(taskId, { issue, steps: [] });
      return patches.get(taskId)!;
    };
    const pushed = (l: GitHubLink, p: Partial<PushedState>): GitHubLink => ({ ...l, pushed: { ...l.pushed, ...p } });
    for (const c of r.created) {
      const a = c.action;
      slot(c.taskId, c.issue).create = {
        taskId: c.taskId, factoryId: def.factoryId, repo: a.issue.repo, issueNumber: a.issue.number, issueNodeId: a.nodeId,
        project: projectKey(settings.project), itemId: a.itemId,
        pushed: { ...emptyPushed(), status: c.status, option: a.option, title: a.title, bodyHash: null, label: a.labelled ? settings.label : null },
        error: null, lease: null, reported: [], version: 0,
      };
    }
    for (const a of r.applied) if (a.onApplied) slot(a.taskId, a.issue).steps.push((l) => pushed(l, a.onApplied!));
    for (const n of r.notApplied) {
      if (!n.taskId || !n.link) continue;
      const { option, report } = n.link;
      slot(n.taskId, n.issue).steps.push((l) => {
        const next = option !== undefined ? pushed(l, { option }) : l;
        return report !== undefined && !next.reported.includes(report) ? { ...next, reported: [...next.reported, report].slice(-REPORTED_MAX) } : next;
      });
    }
    for (const [taskId, p] of patches) {
      const build = (cur: GitHubLink | null): GitHubLink | null => {
        if (cur && p.create) throw new Error(`a link already exists for the new task ${cur.taskId}`);
        const base = cur ?? p.create;
        return base ? p.steps.reduce((l, s) => s(l), structuredClone(base)) : null;
      };
      try {
        await this.save(taskId, build);
      } catch (e) {
        fail(taskId, p.issue, e);
      }
    }
  }

  private async save(taskId: string, build: (cur: GitHubLink | null) => GitHubLink | null): Promise<void> {
    const { store } = this.d;
    for (let attempt = 0; ; attempt++) {
      const cur = (await store.getGitHubLink(taskId)) ?? null;
      const next = build(cur);
      // A live lease belongs to a pusher whose next save would conflict with ours: leave the link, the next pull plans again.
      if (!next || (cur?.lease && Date.parse(cur.lease.until) > this.d.now().getTime()) || (cur && JSON.stringify(cur) === JSON.stringify(next))) return;
      try {
        await store.saveGitHubLink(cur, next);
        return;
      } catch (e) {
        if (!(e instanceof VersionConflictError) || attempt >= 1) throw e;
      }
    }
  }
}
