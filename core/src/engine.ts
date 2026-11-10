import { parseAgentResult } from './agentResult.js';
import { assertPushAllowed, branchName, ProtectedBranchError } from './branchGuard.js';
import { formatReport, runChecks, type Exec } from './checks.js';
import { claim, claimExpired, release, renew } from './claims.js';
import { AGENT_FOR, DEFAULT_SETTINGS } from './defaults.js';
import { GATE_DOC, resolveGates, resolveSettings, shouldMerge, validApproval } from './gates.js';
import type { GitRepos } from './git.js';
import { PrBaseMismatchError, type GitHub } from './github.js';
import { diffEvents } from './history.js';
import { decide, IllegalInputError, type Decision, type Input } from './machine.js';
import type { RepoConfig } from './repoConfig.js';
import { SecretMissingError } from './secrets.js';
import { DocTooLargeError, MAX_DOC_BYTES } from './limits.js';
import { assertMove, IllegalMoveError, TERMINAL } from './status.js';
import {
  CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError,
  updateHeld, VersionConflictError, type BoardStore, type StoredSettings,
} from './store.js';
import type { AgentResult, AgentStep, DocKind, FactoryEvent, Gate, Mode, RepoId, Settings, Status, Step, Task } from './types.js';

export interface EngineDeps {
  store: BoardStore;
  git: GitRepos;
  github: GitHub;
  repos: Record<RepoId, RepoConfig>;
  exec: Exec;
  now: () => Date;
  mode: Mode;
  claimant: string;
  /** Operational notes such as tasks sync skipped (the CLI writes them to stderr). Default: dropped. */
  log?: (msg: string) => void;
}

export interface Ticket {
  taskId: string;
  step: Step;
  worktree: string;
  runId: string | null;
  context: { task: Task; spec?: string; plan?: string; feedback?: string; checks?: string };
}

export interface EngineStatus {
  paused: boolean;
  active: { taskId: string; step: Step | null; claimBy: string | null; claimUntil: string | null }[];
  counts: Partial<Record<Status, number>>;
  tasks: Pick<Task, 'taskId' | 'title' | 'repo' | 'status' | 'stage' | 'blockedReason' | 'question' | 'prUrl'>[];
  /** Global settings. */
  settings: Settings;
}

export class ClaimError extends Error {
  constructor(taskId: string, claimant: string) {
    super(`${taskId} is not claimed by ${claimant}`);
    this.name = 'ClaimError';
  }
}

export class StageError extends Error {
  constructor(taskId: string, step: Step, stage: Step | null) {
    super(`${taskId} is at stage ${stage ?? '-'}, not ${step}`);
    this.name = 'StageError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors that the same call would hit again: retrying only delays them. */
const FINAL_ERRORS = [
  VersionConflictError, SecretMissingError, ProtectedBranchError, PrBaseMismatchError, DocTooLargeError,
  NotFoundError, OwnerOnlyError, CoreFieldError, ForbiddenError, MissingVersionError, RereadAfterUpdateError,
];

/** Retries `fn` with doubling waits (baseMs, 2·baseMs, …) between tries. FINAL_ERRORS are rethrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { tries: number; baseMs: number }): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (FINAL_ERRORS.some((E) => e instanceof E) || i + 1 >= opts.tries) throw e;
      await sleep(opts.baseMs * 2 ** i);
    }
  }
}

const RETRY = { tries: 3, baseMs: 500 };
const retry = <T>(fn: () => Promise<T>) => withRetry(fn, RETRY);

const AGENT_STEPS: ReadonlySet<Step> = new Set<Step>(['spec', 'plan', 'build', 'verify', 'review']);
const WORKING: ReadonlySet<Status> = new Set<Status>(['spec', 'plan', 'build', 'verify', 'review']);
const taskNum = (id: string) => Number(id.slice(id.indexOf('-') + 1)) || 0;

/** One factory's settings, defaults where none are stored. plan 6 Task 4 replaces this single-factory shim (factory `blocks`). */
const factorySettings = (stored: StoredSettings, factoryId = 'blocks'): Settings => stored.factories[factoryId]?.factory ?? DEFAULT_SETTINGS;

export class Engine {
  constructor(private readonly deps: EngineDeps) {}

  private get coreActor() {
    return `core · ${this.deps.mode}`;
  }

  async sync(): Promise<void> {
    const { store } = this.deps;
    const stored = await retry(() => store.getSettings());
    for (const task of await retry(() => store.listTasks())) {
      try {
        const settings = this.settingsFor(stored, task);
        const moved = await this.syncGate(task, settings);
        const t = moved ?? task;
        if (t.stage !== null && t.status !== 'blocked' && !TERMINAL.has(t.status) && t.costUsd > settings.maxCostPerTaskUsd) {
          await this.apply(t, this.decideFor(t, { kind: 'limit', reason: costReason(t.costUsd, settings) }, settings), this.coreActor);
        }
      } catch (e) {
        // Illegal inputs and moves are bugs and surface. Version conflicts and outages that outlast the retries skip this task for this pass.
        if (e instanceof IllegalInputError || e instanceof IllegalMoveError) throw e;
        this.deps.log?.(`sync: skipped ${task.taskId}: ${firstLine(e)}`);
      }
    }
  }

  async next(taskId?: string): Promise<Ticket | null> {
    const { store, now, claimant } = this.deps;
    const stored = await retry(() => store.getSettings());
    const factory = factorySettings(stored);
    if (factory.paused) return null;
    await this.sync();

    const tasks = await retry(() => store.listTasks());
    const active = tasks.filter((t) => !claimExpired(t, now())).length;
    if (active >= factory.maxParallel) return null;

    const workable = (t: Task) => t.status === 'ready' || (t.stage !== null && WORKING.has(t.status));
    const candidates = tasks
      .filter((t) => !this.settingsFor(stored, t).paused)
      .filter((t) => (taskId === undefined ? workable(t) && claimExpired(t, now()) : t.taskId === taskId && workable(t)))
      .sort((a, b) => taskNum(a.taskId) - taskNum(b.taskId));

    for (const candidate of candidates) {
      let claimed: Task | null;
      try {
        claimed = await retry(() => claim(store, candidate, claimant, now()));
      } catch {
        continue; // outage on this task: skip it this pass
      }
      if (!claimed) continue;
      try {
        return await this.ticket(claimed, this.settingsFor(stored, claimed));
      } catch (e) {
        await this.releaseOwnClaim(claimed.taskId);
        if (taskId !== undefined) throw e;
        // One task that cannot be set up must not stop the queue: note why and try the next one.
        await this.noteSetupError(claimed, e);
      }
    }
    return null;
  }

  async complete(taskId: string, step: AgentStep, raw: string | undefined): Promise<Task> {
    return this.completeWith(taskId, step, parseAgentResult(raw, step));
  }

  async completeWith(taskId: string, step: AgentStep, parsed: AgentResult): Promise<Task> {
    const { store, mode } = this.deps;
    await this.claimedAt(taskId, step);
    let result = parsed;
    const run = await retry(() => store.openRun(taskId, step));
    if (!run) throw new Error(`no open ${step} run for ${taskId}`);
    const actor = `${AGENT_FOR[step]} · ${mode} · run ${run.runId}`;

    if (result.status === 'done' && result.doc !== undefined && step !== 'build') {
      const doc = result.doc;
      try {
        await retry(() => store.addDoc(taskId, step, doc, actor));
      } catch (e) {
        if (!(e instanceof DocTooLargeError)) throw e;
        // Deterministic: the doc is not written; the machine decides on a failed result.
        result = { status: 'failed', summary: `invalid agent result: doc larger than ${MAX_DOC_BYTES} bytes` };
      }
    }
    await retry(() =>
      store.finishRun(run.runId, { result: result.status, turns: result.turns ?? null, costUsd: result.costUsd ?? null }),
    );

    // A detached renewal may have bumped the task version while the doc and run were written: decide on the fresh task.
    const task = await this.claimedAt(taskId, step);
    const costUsd = task.costUsd + (result.costUsd ?? 0);
    const settings = this.settingsFor(await retry(() => store.getSettings()), task);
    const input: Input =
      costUsd > settings.maxCostPerTaskUsd
        ? { kind: 'limit', reason: costReason(costUsd, settings) }
        : { kind: 'agent', step, result };
    const decision = this.decideFor(task, input, settings);
    return this.apply(task, { ...decision, patch: { ...decision.patch, costUsd } }, actor);
  }

  async check(taskId: string): Promise<Task> {
    const { store, exec } = this.deps;
    const claimed = await this.claimedAt(taskId, 'check');
    const cfg = this.repo(claimed);
    const worktree = await this.worktreeFor(claimed, requireBranch(claimed));
    const report = await runChecks(cfg, worktree, exec);
    // The checks take a while and the claim may have been renewed meanwhile: decide on the fresh task.
    const task = await this.claimedAt(taskId, 'check');
    const settings = this.settingsFor(await retry(() => store.getSettings()), task);
    await retry(() => store.addDoc(taskId, 'verify', formatReport(report), 'core · checks'));
    const summary = report.steps
      .filter((s) => s.exitCode !== 0)
      .map((s) => s.name)
      .join(', ');
    return this.apply(task, this.decideFor(task, { kind: 'checks', passed: report.passed, summary }, settings), this.coreActor);
  }

  async ship(taskId: string): Promise<Task> {
    const { store, github } = this.deps;
    const claimed = await this.claimedAt(taskId, 'ship');
    const cfg = this.repo(claimed);
    const branch = requireBranch(claimed);
    assertPushAllowed(branch);
    const settings = this.settingsFor(await retry(() => store.getSettings()), claimed);
    const block = (task: Task, reason: string) =>
      this.apply(task, this.decideFor(task, { kind: 'limit', reason }, settings), this.coreActor);

    // A task returned from pr_open already has a PR: reuse it while open. If it merged meanwhile, the commits
    // made for the requested changes are not in it, so the task waits for the user instead of counting as done.
    const existing = claimed.prUrl;
    const state = existing ? await retry(() => github.prState(existing)) : undefined;
    if (existing && state === 'merged') return block(claimed, 'previous PR was merged; new commits are not shipped');

    const worktree = await this.worktreeFor(claimed, branch);
    await this.deps.git.push(worktree, branch);

    // An earlier ship may have opened the PR and failed before recording it: find it before opening a new one.
    const pr =
      existing && state === 'open'
        ? { url: existing }
        : ((await retry(() => github.findOpenPr({ remote: cfg.remote, head: branch, base: claimed.baseBranch }))) ??
          (await retry(() => this.openPr(claimed, cfg, branch))));

    // Push and PR take a while and the claim may have been renewed: record the PR on the fresh task first.
    let task = await this.claimedAt(taskId, 'ship');
    if (task.prUrl !== pr.url) task = await this.record(task, { prUrl: pr.url }, 'PR opened');

    const merged = shouldMerge(task.baseBranch, resolveGates(settings, task.gateOverrides).pr);
    if (merged) {
      try {
        await retry(() => github.mergePr(pr.url, task.baseBranch));
      } catch (e) {
        if (e instanceof PrBaseMismatchError) return block(task, e.message);
        if (e instanceof ProtectedBranchError) return block(task, `${pr.url} targets ${e.branch}, a protected branch; not merged`);
        throw e;
      }
    }
    return this.apply(task, this.decideFor(task, { kind: 'shipped', prUrl: pr.url, merged }, settings), this.coreActor);
  }

  /** Extends this claimant's claim on the task by CLAIM_MS from now; throws ClaimError when the claim is not held. */
  async renew(taskId: string): Promise<Task> {
    const { store, claimant, now } = this.deps;
    const task = await retry(() => store.getTask(taskId));
    const renewed = await retry(() => renew(store, task, claimant, now()));
    if (!renewed) throw new ClaimError(taskId, claimant);
    return renewed;
  }

  async status(): Promise<EngineStatus> {
    const { store, now } = this.deps;
    const stored = await retry(() => store.getSettings());
    const tasks = await retry(() => store.listTasks());
    const counts: Partial<Record<Status, number>> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const active = tasks
      .filter((t) => !claimExpired(t, now()))
      .map((t) => ({ taskId: t.taskId, step: t.stage, claimBy: t.claimBy, claimUntil: t.claimUntil }));
    const list = tasks.map(({ taskId, title, repo, status, stage, blockedReason, question, prUrl }) => ({
      taskId, title, repo, status, stage, blockedReason, question, prUrl,
    }));
    return { paused: factorySettings(stored).paused, active, counts, tasks: list, settings: factorySettings(stored) };
  }

  /** The only way a task changes status: checks the move, writes with the task's version, clears the claim, logs events. */
  private async apply(task: Task, decision: Decision, actor: string, reason = decision.reason): Promise<Task> {
    const { store, now } = this.deps;
    if (decision.status !== task.status) assertMove(task.status, decision.status, 'core');
    const updated = await retry(() =>
      updateHeld(store, task, {
        ...decision.patch,
        // A blocked task waits for a new answer; a stale one must not resume it.
        ...(decision.status === 'blocked' ? { answer: null } : {}),
        status: decision.status,
        stage: decision.stage,
        claimBy: null,
        claimUntil: null,
      }),
    );
    // Built once: a retry must send the same events (same time, same eventId), or a lost reply makes duplicates.
    const events = diffEvents(task, updated, actor, reason, now().toISOString());
    await retry(() => store.addEvents(events));
    return updated;
  }

  /** A version-checked field write that keeps status and claim, with its events. */
  private async record(task: Task, patch: Partial<Task>, reason: string): Promise<Task> {
    const { store, now } = this.deps;
    const updated = await retry(() => updateHeld(store, task, patch));
    const events = diffEvents(task, updated, this.coreActor, reason, now().toISOString());
    await retry(() => store.addEvents(events));
    return updated;
  }

  private async openPr(task: Task, cfg: RepoConfig, branch: string): Promise<{ url: string }> {
    const spec = (await retry(() => this.deps.store.currentDoc(task.taskId, 'spec')))?.body ?? '';
    return this.deps.github.openPr({
      remote: cfg.remote,
      head: branch,
      base: task.baseBranch,
      title: `[${task.taskId}] ${task.title}`,
      body: `Factory task ${task.taskId}\n\n${spec.slice(0, 3000)}`,
    });
  }

  /** Approval, PR and answer moves for one task; returns the moved task, or undefined if nothing moved. */
  private async syncGate(task: Task, settings: Settings): Promise<Task | undefined> {
    const { store, github } = this.deps;
    const approval = async (gate: Gate) => {
      const doc = await retry(() => store.currentDoc(task.taskId, GATE_DOC[gate]));
      return validApproval(await retry(() => store.listApprovals(task.taskId)), gate, doc?.version);
    };

    switch (task.status) {
      case 'spec_review':
      case 'plan_review': {
        const a = await approval(task.status === 'spec_review' ? 'spec' : 'plan');
        return a ? this.apply(task, this.decideFor(task, { kind: 'approval', approval: a }, settings), this.coreActor) : undefined;
      }
      case 'pr_open': {
        const url = task.prUrl;
        if (url) {
          const state = await retry(() => github.prState(url));
          if (state !== 'open') return this.apply(task, this.decideFor(task, { kind: 'pr', state }, settings), this.coreActor);
        }
        const a = await approval('pr');
        if (a?.decision === 'changes') {
          return this.apply(task, this.decideFor(task, { kind: 'approval', approval: a }, settings), this.coreActor);
        }
        if (a?.decision === 'approve' && url && shouldMerge(task.baseBranch, false)) {
          await retry(() => github.mergePr(url, task.baseBranch));
          return this.apply(task, this.decideFor(task, { kind: 'pr', state: 'merged' }, settings), this.coreActor);
        }
        return undefined;
      }
      case 'blocked':
        if (task.answer?.trim() && task.stage !== null) {
          return this.apply(task, this.decideFor(task, { kind: 'answered' }, settings), this.coreActor);
        }
        return undefined;
      default:
        return undefined;
    }
  }

  /** Builds the ticket for a task this claimant just claimed, moving a ready task to spec first. */
  private async ticket(claimed: Task, settings: Settings): Promise<Ticket | null> {
    const { store, git, now, claimant, mode } = this.deps;
    const cfg = this.repo(claimed);
    let task = claimed;
    let worktree: string;
    if (task.status === 'ready') {
      const branch = branchName(task.taskId, task.title);
      await git.ensureClone(cfg);
      worktree = await this.worktreeFor(task, branch);
      const d = this.decideFor(task, { kind: 'claimed' }, settings);
      const moved = await this.apply(task, { ...d, patch: { ...d.patch, branch } }, this.coreActor);
      const reclaimed = await retry(() => claim(store, moved, claimant, now()));
      if (!reclaimed) return null;
      task = reclaimed;
    } else {
      worktree = await this.worktreeFor(task, requireBranch(task));
    }

    const step = task.stage!;
    let runId: string | null = null;
    if (AGENT_STEPS.has(step)) {
      const agentStep = step as AgentStep;
      // Each try looks for the open run first: a start whose reply was lost has made it already.
      const run = await retry(async () =>
        (await store.openRun(task.taskId, step)) ?? store.startRun({ taskId: task.taskId, step, mode, agent: AGENT_FOR[agentStep] }),
      );
      runId = run.runId;
    }

    const body = async (kind: DocKind) => (await retry(() => store.currentDoc(task.taskId, kind)))?.body;
    const context: Ticket['context'] = { task };
    const values = {
      spec: await body('spec'),
      plan: await body('plan'),
      feedback: task.answer ?? undefined,
      checks: await body('verify'),
    };
    for (const [k, v] of Object.entries(values) as [keyof typeof values, string | undefined][]) {
      if (v !== undefined) context[k] = v;
    }
    return { taskId: task.taskId, step, worktree, runId, context };
  }

  /** Best effort: records a setup failure on the task's history; errors are ignored. */
  private async noteSetupError(task: Task, e: unknown): Promise<void> {
    const events: FactoryEvent[] = [
      {
        taskId: task.taskId, factoryId: task.factoryId, actor: this.coreActor, action: 'set', field: 'setupError', from: null, to: firstLine(e),
        reason: 'setup failed', at: this.deps.now().toISOString(),
      },
    ];
    try {
      await retry(() => this.deps.store.addEvents(events));
    } catch {
      // The next pass tries again.
    }
  }

  /** Best effort: drops this claimant's claim on the fresh task; errors are ignored. */
  private async releaseOwnClaim(taskId: string): Promise<void> {
    try {
      const fresh = await retry(() => this.deps.store.getTask(taskId));
      if (fresh.claimBy === this.deps.claimant) await retry(() => release(this.deps.store, fresh));
    } catch {
      // The claim expires on its own.
    }
  }

  /** Reads the task and checks this claimant holds it at `step`. A lapsed claim nobody re-claimed still counts. */
  private async claimedAt(taskId: string, step: Step): Promise<Task> {
    const task = await retry(() => this.deps.store.getTask(taskId));
    if (task.claimBy !== this.deps.claimant) throw new ClaimError(taskId, this.deps.claimant);
    if (task.stage !== step) throw new StageError(taskId, step, task.stage);
    return task;
  }

  private decideFor(task: Task, input: Input, settings: Settings): Decision {
    return decide(task, input, resolveGates(settings, task.gateOverrides));
  }

  private settingsFor(stored: StoredSettings, task: Task): Settings {
    const entry = stored.factories[task.factoryId];
    return resolveSettings(entry?.factory ?? DEFAULT_SETTINGS, entry?.repos[task.repo]);
  }

  /** The task's worktree; a new one branches from the task's base, not the repo default. */
  private worktreeFor(task: Task, branch: string): Promise<string> {
    return this.deps.git.worktree({ ...this.repo(task), baseBranch: task.baseBranch }, task.taskId, branch);
  }

  private repo(task: Task): RepoConfig {
    const cfg = this.deps.repos[task.repo];
    if (!cfg) throw new Error(`no repo config for ${task.repo}`);
    return cfg;
  }
}

function requireBranch(task: Task): string {
  if (!task.branch) throw new Error(`${task.taskId} has no branch`);
  return task.branch;
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
}

function costReason(cost: number, s: Settings): string {
  return `cost limit reached ($${cost.toFixed(2)} > $${s.maxCostPerTaskUsd})`;
}
