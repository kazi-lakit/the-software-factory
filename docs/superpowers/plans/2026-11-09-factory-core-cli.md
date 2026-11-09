# Factory Core and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `core/`, the TypeScript library and `factory` CLI that hold every factory rule (statuses, gates, claims, history, worktrees, checks, push/PR/merge) and are the only writer to the Board and GitHub.

**Architecture:** Pure decision functions (`status`, `gates`, `machine`) sit under an `Engine` that talks to four ports: `BoardStore`, `GitRepos`, `GitHub` and `Exec`. This plan ships an in-memory store and a JSON file store, so the CLI works end to end on your Mac before the Blocks project exists. The Blocks Data store is plan 2. The SDK runner, plugin and Board page are later plans and call this CLI and library.

**Tech Stack:** Node 22+, TypeScript (strict, ESM), vitest, zod 3, yaml 2, commander 12, @octokit/rest 21, system `git`.

**Spec:** `docs/superpowers/specs/2026-11-09-software-factory-design.md` (approved 2026-11-09). This plan covers spec §3 `core/`, §4 (store side), §5, §6, §7 (core steps), §8 (CLI), §9 (repo config), §10 (core rows), §11 (core, branch guard, integration). Plan order after this one: 2 Blocks project + Blocks store + doc size spike, 3 Board page, 4 plugin, 5 SDK runner.

## Global Constraints

- All paths are relative to `~/scratchpad/selise/the-software-factory`. Code goes in `core/` and repo configs go in `repos/`.
- Protected branches are exactly `dev`, `stg`, `main`. Nothing pushes or merges into them. A PR is the only way in.
- Task branch: `factory/<task-id>-<slug>`, where the slug is lowercase `a-z0-9-` and at most 40 characters.
- Clones go in `.clones/<repo>`. Task worktrees go in `.clones/worktrees/<task-id>`. Never use `~/scratchpad/selise/blocks/` and never write to `vaultS/`.
- Claims last 10 minutes (`CLAIM_MS = 600_000`).
- `MAX_RETURNS = 3`: the third return to build blocks the task.
- Default settings:
  - gates `{spec: true, plan: false, pr: true}`
  - `maxParallel: 2`
  - `maxTurnsPerStage: 60` and `maxCostPerTaskUsd: 5` (provisional until spec §12.2, but they must be constants in `core/src/defaults.ts`)
  - `paused: false`
- Secrets come only from the macOS Keychain (service `the-software-factory`, accounts `github-pat` and `blocks-credential`). They are never printed, logged or written to a file.
- Agents never call `push`, `openPr` or `mergePr`. Only `Engine.ship` does.
- Each step's commit assumes the folder is a git repo, and it isn't one yet (spec §12.4). Before the first commit, ask the user whether to run `git init` here. Don't change git config or add remotes.

## Review Focus

1. **Stale approval:** an approval for spec v1 when the current spec is v2 must not move the task out of `spec_review`. Test in Task 2.
2. **Two claimers at once:** two `claim` calls on the same task version must leave exactly one winner, and the loser gets `null` rather than an error. Test in Task 7.
3. **PR gate off with a protected base:** a task based on `dev` with the PR gate off must still stop at `pr_open` without a merge. Tests in Task 2 (`shouldMerge`) and Task 11.
4. **Bad agent result:** a missing file, non-JSON content, unknown `status`, or `done` without the required `doc` or `verdict` becomes a `failed` result, never a crash. Test in Task 4.
5. **Answered blocked task:** it resumes at the step where it stopped, with `attempt` reset to 0 and the question cleared. Without the reset it would block again immediately. Test in Task 3.

---

### Task 1: Package scaffold, types and the status table

**Files:**
- Create: `core/package.json`, `core/tsconfig.json`, `core/vitest.config.ts`
- Create: `core/src/types.ts`, `core/src/defaults.ts`, `core/src/status.ts`
- Test: `core/test/status.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `RepoId = 'os'|'iam'|'monitor'|'logic'|'data'|'localization'|'release'`
  - `Status = 'inbox'|'ready'|'spec'|'spec_review'|'plan'|'plan_review'|'build'|'verify'|'review'|'pr_open'|'done'|'blocked'|'cancelled'`
  - `Step = 'spec'|'plan'|'build'|'check'|'verify'|'review'|'ship'`
  - `AgentStep = 'spec'|'plan'|'build'|'verify'|'review'`
  - `Gate = 'spec'|'plan'|'pr'`, `DocKind = 'spec'|'plan'|'verify'|'review'`, `Mode = 'sdk'|'loop'|'session'`
  - `Task {taskId, title, description, repo: RepoId, baseBranch, status: Status, stage: Step|null, branch: string|null, prUrl: string|null, attempt: number, blockedReason: string|null, question: string|null, answer: string|null, gateOverrides: Partial<Record<Gate,boolean>>, claimBy: string|null, claimUntil: string|null /*ISO*/, costUsd: number, version: number}`
  - `Doc {taskId, kind: DocKind, version: number, body: string, author: string, status: 'current'|'superseded'}`
  - `Approval {taskId, gate: Gate, docVersion: number, decision: 'approve'|'changes', comment: string, at: string}`
  - `Settings {gates: Record<Gate,boolean>, maxParallel, maxTurnsPerStage, maxCostPerTaskUsd: number, paused: boolean}`, `RepoSettings = Partial<Omit<Settings,'gates'>> & {gates?: Partial<Record<Gate,boolean>>}`
  - `Run {runId, taskId, step: Step, mode: Mode, agent: string, startedAt: string, endedAt: string|null, result: string|null, turns: number|null, costUsd: number|null}`
  - `FactoryEvent {taskId, actor, action: 'move'|'set'|'create', field: string|null, from: string|null, to: string|null, reason: string, at: string}`
  - `AgentResult {status: 'done'|'blocked'|'failed', summary: string, question?: string, verdict?: 'pass'|'fail'|'approve'|'changes', doc?: string, turns?: number, costUsd?: number}`
- Produces (`defaults.ts`): `DEFAULT_SETTINGS: Settings`, `CLAIM_MS`, `MAX_RETURNS`, `AGENT_FOR: Record<AgentStep, string>` = `{spec:'spec-writer', plan:'planner', build:'implementer', verify:'verifier', review:'reviewer'}`
- Produces (`status.ts`): `type Mover = 'you'|'core'`, `canMove(from: Status, to: Status, by: Mover): boolean`, `assertMove(from, to, by): void` (throws `IllegalMoveError`), `STEP_STATUS: Record<Step, Status>`, `TERMINAL: ReadonlySet<Status>` = `{done, cancelled}`

- [ ] **Step 1: Scaffold the package.** Use `"type": "module"`, `bin: {factory: "dist/cli.js"}` and the scripts `build: tsc`, `typecheck: tsc --noEmit`, `test: vitest run`. Set `engines.node >=22`. Set tsconfig to `strict`, `module/moduleResolution: NodeNext`, `outDir dist`. Then run `npm install` in `core/`.

- [ ] **Step 2: Write the failing tests**

```ts
// core/test/status.test.ts
test('core moves follow spec §5', () => {
  for (const [f, t] of [['ready','spec'],['spec','spec_review'],['spec','plan'],['spec_review','plan'],['spec_review','spec'],
    ['plan','plan_review'],['plan','build'],['plan_review','build'],['plan_review','plan'],['build','verify'],
    ['verify','review'],['verify','build'],['review','pr_open'],['review','build'],['review','done'],
    ['pr_open','done'],['pr_open','build'],['blocked','build'],['blocked','verify'],['spec','blocked'],['pr_open','blocked']] as const)
    expect(canMove(f, t, 'core')).toBe(true);
});
test('core cannot skip stages or leave terminal states', () => {
  expect(canMove('ready','build','core')).toBe(false);
  expect(canMove('spec','build','core')).toBe(false);
  expect(canMove('build','pr_open','core')).toBe(false);
  expect(canMove('done','blocked','core')).toBe(false);
  expect(canMove('inbox','ready','core')).toBe(false);
  expect(() => assertMove('spec','build','core')).toThrow(IllegalMoveError);
});
test('you can only mark ready and cancel', () => {
  expect(canMove('inbox','ready','you')).toBe(true);
  expect(canMove('build','cancelled','you')).toBe(true);
  expect(canMove('done','cancelled','you')).toBe(false);
  expect(canMove('spec_review','plan','you')).toBe(false);
});
test('STEP_STATUS maps core steps to their column', () => {
  expect(STEP_STATUS.check).toBe('verify');
  expect(STEP_STATUS.ship).toBe('review');
});
```

- [ ] **Step 3: Run the tests.** Run `cd core && npx vitest run test/status.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement `types.ts`, `defaults.ts` and `status.ts`.** Core moves are the pairs in the first test. Also allow `blocked` from every non-terminal status, and allow `blocked` to go to `spec|plan|build|verify|review`. Your moves are `inbox→ready`, plus `→cancelled` from every non-terminal status.

- [ ] **Step 5: Run the tests.** Same command. Expected: PASS. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6: Commit.** Run `git add core && git commit -m "feat(core): types, defaults and status table"`.

---

### Task 2: Gates

**Files:**
- Create: `core/src/gates.ts`
- Test: `core/test/gates.test.ts`

**Interfaces:**
- Consumes: `Settings`, `RepoSettings`, `Approval`, `Gate` (Task 1); `isProtected` (Task 6). To avoid an ordering problem, create `core/src/branchGuard.ts` here with only `PROTECTED_BRANCHES` and `isProtected`. Task 6 extends that file.
- Produces:
  - `resolveSettings(global: Settings, repo?: RepoSettings): Settings`
  - `resolveGates(s: Settings, overrides: Partial<Record<Gate,boolean>>): Record<Gate,boolean>`
  - `validApproval(approvals: Approval[], gate: Gate, currentDocVersion: number|undefined): Approval|undefined`
  - `shouldMerge(baseBranch: string, prGateOn: boolean): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
test('most specific gate wins', () => {
  const s = resolveSettings(DEFAULT_SETTINGS, { gates: { spec: false } });
  expect(resolveGates(s, {})).toEqual({ spec: false, plan: false, pr: true });
  expect(resolveGates(s, { spec: true, plan: true })).toEqual({ spec: true, plan: true, pr: true });
  expect(resolveSettings(DEFAULT_SETTINGS, { maxParallel: 1 }).maxParallel).toBe(1);
});
test('approval for an older doc version does not count', () => {
  const a = (v: number, d: 'approve'|'changes', at: string) => ({ taskId: 'T-1', gate: 'spec' as const, docVersion: v, decision: d, comment: '', at });
  expect(validApproval([a(1,'approve','2026-11-09T10:00Z')], 'spec', 2)).toBeUndefined();
  expect(validApproval([a(2,'changes','2026-11-09T10:00Z'), a(2,'approve','2026-11-09T11:00Z')], 'spec', 2)?.decision).toBe('approve');
  expect(validApproval([a(1,'approve','x')], 'plan', 1)).toBeUndefined();
  expect(validApproval([], 'spec', undefined)).toBeUndefined();
});
test('PR gate off never merges into a protected branch', () => {
  expect(shouldMerge('dev', false)).toBe(false);
  expect(shouldMerge('stg', false)).toBe(false);
  expect(shouldMerge('main', false)).toBe(false);
  expect(shouldMerge('feature/x', false)).toBe(true);
  expect(shouldMerge('feature/x', true)).toBe(false);
});
```

- [ ] **Step 2: Run the tests.** Run `npx vitest run test/gates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `gates.ts`.** When several approvals match the gate and the version, `validApproval` returns the one with the latest `at`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): gate resolution and versioned approvals`.

---

### Task 3: Decision machine

**Files:**
- Create: `core/src/machine.ts`
- Test: `core/test/machine.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `MAX_RETURNS`, `STEP_STATUS`.
- Produces:
  - `type Input = {kind:'claimed'} | {kind:'agent', step: AgentStep, result: AgentResult} | {kind:'checks', passed: boolean, summary: string} | {kind:'approval', approval: Approval} | {kind:'shipped', prUrl: string, merged: boolean} | {kind:'pr', state: 'merged'|'closed'} | {kind:'answered'} | {kind:'limit', reason: string}`
  - `interface Decision {status: Status, stage: Step|null, patch: Partial<Task>, reason: string}`
  - `decide(task: Task, input: Input, gates: Record<Gate,boolean>): Decision`. It's a pure function and throws `IllegalInputError` for an input that doesn't fit the task's status or stage.

Rules (spec §5, §10):

| Task state | Input | Result |
|---|---|---|
| ready | claimed | spec / stage spec |
| spec / spec | agent done | spec_review / null if gate spec, else plan / plan |
| spec_review | approval approve / changes | plan / plan; spec / spec with `patch.answer = comment` |
| plan / plan | agent done | plan_review / null if gate plan, else build / build |
| plan_review | approval approve / changes | build / build; plan / plan with `answer = comment` |
| build / build | agent done | verify / check |
| verify / check | checks passed / failed | verify / verify; return to build |
| verify / verify | verdict pass / fail | review / review; return to build |
| review / review | verdict approve / changes | review / ship; return to build |
| review / ship | shipped merged / not merged | done / null; pr_open / null, with `prUrl` |
| pr_open | approval changes | return to build |
| pr_open | pr merged / closed | done; blocked / stage build with reason `PR closed without merge` |
| any | agent blocked | blocked, stage unchanged, `question = result.question ?? summary` |
| verify or review | agent failed | return to build |
| other steps | agent failed | blocked, stage unchanged, `blockedReason = summary` |
| any non-terminal | limit | blocked, stage unchanged, `blockedReason = reason` |
| blocked | answered | `STEP_STATUS[stage]` / stage, with `attempt 0`, `question`, `blockedReason` and `answer` set to null. Keep `answer` when the stage is `spec`, `plan` or `build`, so the agent sees it |

**Return to build:** `attempt + 1`, and `answer` is set to the feedback (the review doc summary, the check summary, or the approval comment). If the new attempt is ≥ `MAX_RETURNS`, the result is blocked / stage build with `blockedReason: "returned to build 3 times"` and the last feedback as the `question`.

- [ ] **Step 1: Write the failing tests.** Use a `task(over: Partial<Task>)` factory with defaults (`status 'ready'`, `attempt 0`, `version 1`). Write one test per table row. Pin these assertions:

```ts
test('spec done goes to review only when the spec gate is on', () => {
  const t = task({ status: 'spec', stage: 'spec' });
  expect(decide(t, done('spec'), { spec: true, plan: false, pr: true })).toMatchObject({ status: 'spec_review', stage: null });
  expect(decide(t, done('spec'), { spec: false, plan: false, pr: true })).toMatchObject({ status: 'plan', stage: 'plan' });
});
test('third return to build blocks', () => {
  const t = task({ status: 'verify', stage: 'check', attempt: 2 });
  expect(decide(t, { kind: 'checks', passed: false, summary: 'dotnet test: 2 failed' }, G))
    .toMatchObject({ status: 'blocked', stage: 'build', patch: { attempt: 3, blockedReason: 'returned to build 3 times', question: 'dotnet test: 2 failed' } });
  expect(decide(task({ status: 'verify', stage: 'check', attempt: 1 }), { kind: 'checks', passed: false, summary: 's' }, G))
    .toMatchObject({ status: 'build', stage: 'build', patch: { attempt: 2, answer: 's' } });
});
test('answered blocked task resumes where it stopped with attempt reset', () => {
  const t = task({ status: 'blocked', stage: 'verify', attempt: 3, question: 'q', blockedReason: 'r', answer: 'use the v2 API' });
  expect(decide(t, { kind: 'answered' }, G)).toMatchObject({ status: 'verify', stage: 'verify', patch: { attempt: 0, question: null, blockedReason: null, answer: null } });
});
test('agent failure at spec blocks, at review returns to build', () => { /* two asserts per the table */ });
test('input that does not fit the status throws', () => {
  expect(() => decide(task({ status: 'spec', stage: 'spec' }), { kind: 'checks', passed: true, summary: '' }, G)).toThrow(IllegalInputError);
});
```

- [ ] **Step 2: Run the tests.** Run `npx vitest run test/machine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `decide`.** Use a `switch` on `input.kind` with one private helper, `returnToBuild(task, feedback)`. Every result must also pass `assertMove(task.status, result.status, 'core')` when the status changes, and a test must check this for each row.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): decision machine for task moves`.

---

### Task 4: Agent result parsing

**Files:**
- Create: `core/src/agentResult.ts`
- Test: `core/test/agentResult.test.ts`

**Interfaces:**
- Produces: `parseAgentResult(raw: string|undefined, step: AgentStep): AgentResult`. It never throws.

Rules:
- Validate with a zod schema for `AgentResult`. Unknown keys are stripped.
- A `done` result must include a `doc` for `spec`, `plan`, `verify` and `review`.
- A `done` verify result needs a `verdict` of `pass|fail`. A `done` review result needs `approve|changes`.
- Any failure returns `{status: 'failed', summary: 'invalid agent result: <reason>'}`.

- [ ] **Step 1: Write the failing tests**

```ts
test.each([
  [undefined, 'missing'], ['not json', 'JSON'], ['{"status":"ok","summary":"x"}', 'status'],
  ['{"status":"done","summary":"x"}', 'doc'], ['{"status":"done","summary":"x","doc":"d"}', 'verdict'],
])('bad input %s fails cleanly', (raw, reason) => {
  const r = parseAgentResult(raw, 'review');
  expect(r.status).toBe('failed');
  expect(r.summary).toMatch(new RegExp(`^invalid agent result: .*${reason}`, 'i'));
});
test('valid review result passes through', () => {
  expect(parseAgentResult('{"status":"done","summary":"ok","doc":"# Review","verdict":"approve","turns":12,"costUsd":0.4,"extra":1}', 'review'))
    .toEqual({ status: 'done', summary: 'ok', doc: '# Review', verdict: 'approve', turns: 12, costUsd: 0.4 });
});
test('build done needs no doc or verdict', () => {
  expect(parseAgentResult('{"status":"done","summary":"3 commits"}', 'build').status).toBe('done');
});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): parse agent results safely`.

---

### Task 5: Repo configs

**Files:**
- Create: `core/src/repoConfig.ts`
- Create: `repos/os.yaml`, `repos/iam.yaml`, `repos/monitor.yaml`, `repos/logic.yaml`, `repos/data.yaml`, `repos/localization.yaml`, `repos/release.yaml`
- Test: `core/test/repoConfig.test.ts`

**Interfaces:**
- Produces:
  - `RepoConfig {repo: RepoId, remote: string, baseBranch: string, checks: {server: {cwd, build, test}, client: {cwd, install, typecheck, lint, test}, e2e: 'off'}}`
  - `loadRepoConfig(reposDir: string, repo: RepoId): RepoConfig`
  - `loadAllRepoConfigs(reposDir: string): Record<RepoId, RepoConfig>`
  - Both throw `RepoConfigError` naming the file and the field.

**Values** (spec §9):
- Remote: `git@github.com:SELISEdigitalplatforms/blocks-<repo>.git`
- `baseBranch: dev`
- Server: `cwd server`, `build: dotnet build <sln>` and `test: dotnet test <sln>`. The sln is `BlocksOS.sln` for os, `BlocksIAM.sln` for iam, and `Blocks.slnx` for the other five.
- Client: `cwd client`, `npm ci`, `npm run type-check`, `npm run lint`, `npm test`
- `e2e: off`

- [ ] **Step 1: Write the failing tests.**
  - `loadAllRepoConfigs('../repos')` returns all 7 repos.
  - `iam.checks.server.build === 'dotnet build BlocksIAM.sln'`.
  - Every `remote` matches `/SELISEdigitalplatforms\/blocks-[a-z]+\.git$/`.
  - A temp yaml with `repo: data` saved as `os.yaml` throws `RepoConfigError` with `/os\.yaml.*repo/`.
  - A temp yaml missing `checks.client.lint` throws with `/checks\.client\.lint/`.
- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement with zod and `yaml`, and write the 7 files. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): repo configs for the 7 Blocks repos`.

---

### Task 6: Branch guard and pre-push hook

**Files:**
- Modify: `core/src/branchGuard.ts` (from Task 2)
- Create: `core/hooks/pre-push` (POSIX `sh`, executable)
- Test: `core/test/branchGuard.test.ts`

**Interfaces:**
- Produces:
  - `PROTECTED_BRANCHES = ['dev','stg','main'] as const`
  - `isProtected(ref: string): boolean`, which strips `refs/heads/` and `origin/` and then matches exactly
  - `assertPushAllowed(branch: string): void`, which throws `ProtectedBranchError`
  - `branchName(taskId: string, title: string): string`
  - `HOOK_PATH`, the absolute path of `core/hooks/pre-push`

- [ ] **Step 1: Write the failing tests**

```ts
test.each(Object.values(loadAllRepoConfigs(REPOS)))('$repo: protected branches refused', (cfg) => {
  for (const b of [cfg.baseBranch, 'stg', 'main', 'refs/heads/main', 'origin/dev'])
    expect(() => assertPushAllowed(b)).toThrow(ProtectedBranchError);
  expect(() => assertPushAllowed(branchName('T-12', 'Add retry to export'))).not.toThrow();
});
test('look-alike names are not protected', () => {
  expect(isProtected('dev2')).toBe(false); expect(isProtected('feature/main')).toBe(false);
});
test('branchName', () => {
  expect(branchName('T-12', 'Add retry: to Export!!')).toBe('factory/T-12-add-retry-to-export');
  expect(branchName('T-1', 'x'.repeat(80))).toHaveLength('factory/T-1-'.length + 40);
});
test('pre-push hook refuses dev, stg, main and allows task branches', async () => {
  // tmp bare repo + clone with core.hooksPath unset; copy HOOK_PATH into .git/hooks/pre-push
  // git push origin HEAD:refs/heads/main  -> exit code != 0, stderr contains "factory: push to main refused"
  // git push origin HEAD:refs/heads/factory/T-1-x -> exit code 0
});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement the guard and the hook. The hook reads `<local ref> <local sha> <remote ref> <remote sha>` lines from stdin and exits 1 when a remote ref is `refs/heads/dev|stg|main`. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): branch guard and pre-push hook`.

---

### Task 7: Board store, history and claims

**Files:**
- Create: `core/src/store.ts` (the `BoardStore` interface, `MemoryStore` and `FileStore`)
- Create: `core/src/history.ts`, `core/src/claims.ts`
- Test: `core/test/store.test.ts`, `core/test/history.test.ts`, `core/test/claims.test.ts`

**Interfaces:**
- Produces (`store.ts`), the `interface BoardStore`:
  - `listTasks(): Promise<Task[]>`
  - `getTask(id: string): Promise<Task>`, which throws `NotFoundError`
  - `createTask(t: {title, description, repo: RepoId, baseBranch?: string}): Promise<Task>`, which assigns `T-<n>`, `status 'inbox'`, `version 1`
  - `updateTask(id: string, expectedVersion: number, patch: Partial<Task>): Promise<Task>`, which throws `VersionConflictError` and returns `version + 1`
  - `addDoc(taskId, kind: DocKind, body: string, author: string): Promise<Doc>`, where the version is the previous one + 1 and the previous one becomes `superseded`
  - `currentDoc(taskId, kind): Promise<Doc|undefined>`
  - `addApproval(a: Omit<Approval,'at'>): Promise<Approval>`, `listApprovals(taskId): Promise<Approval[]>`
  - `getSettings(): Promise<{global: Settings, repos: Partial<Record<RepoId, RepoSettings>>}>`, `setSettings(...)` (same shape, dev use only)
  - `startRun(r: {taskId, step, mode, agent}): Promise<Run>`, `openRun(taskId, step): Promise<Run|undefined>`, `finishRun(runId, p: {result: string, turns: number|null, costUsd: number|null}): Promise<void>`
  - `addEvents(e: FactoryEvent[]): Promise<void>`, `listEvents(taskId?: string): Promise<FactoryEvent[]>`
  - There are no update or delete methods for events, docs or approvals.
- Produces (`store.ts`): `class MemoryStore implements BoardStore`, and `class FileStore extends MemoryStore`, built with `(path: string)`, which loads its JSON on construction and writes it after each change (tmp file + rename).
- Produces (`history.ts`): `diffEvents(before: Task, after: Task, actor: string, reason: string, at: string): FactoryEvent[]`. It writes one event per changed field among `status` (action `move`), `stage`, `branch`, `prUrl`, `attempt`, `blockedReason`, `question`, `answer`, `claimBy` and `costUsd` (action `set`). It ignores `version` and `claimUntil`.
- Produces (`claims.ts`):
  - `claimExpired(t: Task, now: Date): boolean`
  - `claim(store, t: Task, claimant: string, now: Date): Promise<Task|null>`
  - `release(store, t: Task): Promise<Task>`
  - `renew(store, t: Task, claimant: string, now: Date): Promise<Task|null>`, which sets `claimUntil = now + CLAIM_MS` only while `claimBy === claimant`, and otherwise returns `null`. The SDK runner (plan 5) calls it every minute.

- [ ] **Step 1: Write the failing tests.** Pin these:
  - **store:** `updateTask` with a stale version throws `VersionConflictError`. Two `addDoc` calls give versions 1 and 2, and the first becomes `superseded`. `FileStore` reloads what an earlier instance wrote. `createTask` ids go `T-1`, `T-2`. `getSettings()` on an empty store returns `DEFAULT_SETTINGS`.
  - **history:** moving `build→verify` and setting `stage build→check` gives exactly two events, `{action:'move', field:'status', from:'build', to:'verify'}` and `{action:'set', field:'stage'}`. A change only to `version` gives `[]`.
  - **claims:**

```ts
test('two claimers on the same version: one wins, one gets null', async () => {
  const s = new MemoryStore(); const t = await s.createTask({ title: 'a', description: '', repo: 'data' });
  const [a, b] = await Promise.all([claim(s, t, 'sdk:A', NOW), claim(s, t, 'sdk:B', NOW)]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
});
test('held claim blocks others until it expires after 10 minutes', async () => {
  const held = (await claim(s, t, 'sdk:A', NOW))!;
  expect(await claim(s, held, 'sdk:B', new Date(NOW.getTime() + 599_000))).toBeNull();
  expect((await claim(s, held, 'sdk:B', new Date(NOW.getTime() + 600_001)))?.claimBy).toBe('sdk:B');
});
test('renew extends only your own claim', async () => {
  const held = (await claim(s, t, 'sdk:A', NOW))!;
  expect((await renew(s, held, 'sdk:A', new Date(NOW.getTime() + 60_000)))?.claimUntil).toBe(new Date(NOW.getTime() + 660_000).toISOString());
  expect(await renew(s, held, 'sdk:B', NOW)).toBeNull();
});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement. `MemoryStore.updateTask` checks the version and applies the patch in one synchronous section, so `Promise.all` claims stay atomic. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): board store, history events and claims`.

---

### Task 8: Git clones and worktrees

**Files:**
- Create: `core/src/git.ts`
- Test: `core/test/git.test.ts` (real `git` against temp repos)

**Interfaces:**
- Consumes: `RepoConfig`, `assertPushAllowed`, `HOOK_PATH`.
- Produces: `interface GitRepos`, implemented by `class LocalGitRepos` and built with `(root: string)`, where `root` is the factory folder:
  - `ensureClone(cfg: RepoConfig): Promise<string>` returns `<root>/.clones/<repo>`. It clones if the folder is missing, then runs `git fetch origin` and installs `HOOK_PATH` as `.git/hooks/pre-push` (mode 755).
  - `worktree(cfg: RepoConfig, taskId: string, branch: string): Promise<string>` returns `<root>/.clones/worktrees/<taskId>`. If the folder exists, it's reused as is. Otherwise it runs `git worktree add -b <branch> <path> origin/<baseBranch>`.
  - `push(worktreePath: string, branch: string): Promise<void>` calls `assertPushAllowed(branch)` before `git push -u origin <branch>`.
  - `isClean(path: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests.**
  - Make a temp bare remote with a `dev` branch and set `cfg.remote` to its path.
  - `ensureClone` twice gives the same path, and the hook file exists and is executable.
  - `worktree` creates the branch from `origin/dev`, and a second call returns the same path without an error.
  - `push(wt, 'factory/T-1-x')` makes the branch visible in `git ls-remote`.
  - `push(wt, 'dev')` rejects with `ProtectedBranchError`, and `git ls-remote` shows `dev` unchanged.
- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement with `execFile('git', args, {cwd})`. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): factory clones, worktrees and guarded push`.

---

### Task 9: GitHub and Keychain secrets

**Files:**
- Create: `core/src/github.ts`, `core/src/secrets.ts`
- Test: `core/test/github.test.ts`, `core/test/secrets.test.ts`

**Interfaces:**
- Produces (`github.ts`): `interface GitHub` with these methods:
  - `openPr(p: {remote, head, base, title, body}): Promise<{url: string, number: number}>`
  - `prState(url: string): Promise<'open'|'merged'|'closed'>`
  - `mergePr(url: string, base: string): Promise<void>`
- It also produces:
  - `parseRemote(remote: string): {owner: string, repo: string}`
  - `class OctokitGitHub implements GitHub`, built with `(token: string)`
  - `class FakeGitHub implements GitHub`, with a public `prs: Map<string, {base, head, state}>` and `setState(url, state)`
- `mergePr` in both classes throws `ProtectedBranchError` for a protected `base` before doing anything else.
- Produces (`secrets.ts`): `readSecret(name: 'github-pat'|'blocks-credential', exec?: ExecFile): Promise<string>`. It runs `security find-generic-password -s the-software-factory -a <name> -w`. On failure it throws `SecretMissingError('<name> not found in Keychain (service the-software-factory)')`, and the error must not include stdout or stderr.

- [ ] **Step 1: Write the failing tests.**
  - `parseRemote` works on both `git@github.com:SELISEdigitalplatforms/blocks-data.git` and `https://github.com/SELISEdigitalplatforms/blocks-data`.
  - `new OctokitGitHub('t').mergePr(url, 'main')` rejects with `ProtectedBranchError` and makes no network call. Stub `fetch` and assert it wasn't called.
  - `FakeGitHub` gives an `open` state after `openPr`, and the `merged` state after `mergePr(url, 'feature/x')`.
  - `readSecret` with a stub exec that exits 44 rejects with the exact message, and the message doesn't contain the stub's stderr text `SECRET-LEAK`.
- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): GitHub port and Keychain secrets`.

---

### Task 10: Checks runner

**Files:**
- Create: `core/src/checks.ts`
- Test: `core/test/checks.test.ts`

**Interfaces:**
- Produces:
  - `type Exec = (cmd: string, cwd: string) => Promise<{code: number, output: string}>`
  - `shellExec: Exec` (spawn with `shell: true`, stdout and stderr merged)
  - `CheckReport {passed: boolean, steps: {name: string, command: string, exitCode: number|null, output: string}[]}`
  - `runChecks(cfg: RepoConfig, worktree: string, exec?: Exec): Promise<CheckReport>`
  - `formatReport(r: CheckReport): string`

Order: `server.build`, `server.test`, `client.install`, `client.typecheck`, `client.lint`, `client.test`. Skip `server.test` when `server.build` fails, and skip the remaining client steps when `client.install` fails. A skipped step has `exitCode: null`. `output` keeps the last 4000 characters. `passed` is true only if every step exits 0.

- [ ] **Step 1: Write the failing tests.** With a stub exec where `dotnet build` exits 1:
  - `server.test` is skipped, `client.*` still runs, and `passed` is false.
  - The stub gets each command with its `cwd` as `<worktree>/server` or `<worktree>/client`.
  - 10,000 characters of output are cut to 4000.
  - `formatReport` contains a line per step like `- ❌ server.build (exit 1)` / `- ✅ client.lint` / `- ⏭ server.test (skipped)`.
- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): repo checks runner`.

---

### Task 11: Engine

**Files:**
- Create: `core/src/engine.ts`
- Test: `core/test/engine.test.ts` (uses `MemoryStore`, `FakeGitHub`, a fake `GitRepos` and a stub `Exec`)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface EngineDeps {store: BoardStore, git: GitRepos, github: GitHub, repos: Record<RepoId, RepoConfig>, exec: Exec, now: () => Date, mode: Mode, claimant: string}`
  - `interface Ticket {taskId, step: Step, worktree: string, runId: string|null, context: {task: Task, spec?: string, plan?: string, feedback?: string, checks?: string}}`
  - `class Engine`, built with `(deps)`, with these methods:
    - `sync(): Promise<void>`
    - `next(taskId?: string): Promise<Ticket|null>`
    - `complete(taskId: string, step: AgentStep, raw: string|undefined): Promise<Task>`
    - `check(taskId: string): Promise<Task>`
    - `ship(taskId: string): Promise<Task>`
    - `status(): Promise<{paused: boolean, active: {taskId, step, claimBy, claimUntil}[], counts: Partial<Record<Status, number>>}>`
  - Errors: `ClaimError` (the task isn't claimed by this claimant) and `StageError` (`step !== task.stage`).

**Behaviour:**
- **Applying a decision:** every move goes through one private `apply(task, decision, actor, reason)`. It runs `assertMove`, then `updateTask` with the task's version, the decision's patch and `claimBy/claimUntil: null`. Then it calls `addEvents(diffEvents(...))`.
- **Actors:**
  - agent steps: `${AGENT_FOR[step]} · ${mode} · run ${runId}`
  - core steps: `core · ${mode}`
- **Outages (spec §10):** every `store` and `github` call in the engine goes through `withRetry(fn, {tries: 3, baseMs: 500})` (exported from `engine.ts`), which waits 500, 1000 and 2000 ms. A `VersionConflictError` is never retried. After the third failure, `sync` and `next` skip that task for this pass without moving it. Errors from `complete`, `check` and `ship` reach the caller.
- **`sync()`** goes over the tasks once and skips any task that hits a `VersionConflictError`:
  - `spec_review`, `plan_review`: look for a `validApproval` against the current spec or plan doc version. If there is one, apply `approval`.
  - `pr_open`:
    - First, if `prState` is `merged` or `closed`, apply `pr`.
    - Otherwise, with a valid `pr` approval against the current review doc: `changes` applies `approval`. `approve` calls `mergePr` and applies `pr merged`, but only when `shouldMerge(base, false)` is true. If the base is protected, `approve` is ignored and you merge on GitHub.
  - `blocked` with a non-empty `answer`: apply `answered`.
  - Any non-terminal task with `costUsd > maxCostPerTaskUsd`: apply `limit`.
- **`next(taskId?)`:**
  - Return `null` when settings are `paused`.
  - Run `sync()`.
  - Return `null` when the number of tasks with an unexpired claim is at least `maxParallel`.
  - Pick the explicit task, or the lowest `T-<n>` that is either `ready` or has a non-null `stage` in `spec|plan|build|verify|review` with no unexpired claim. Then `claim` it.
  - For a `ready` task: `ensureClone`, `worktree(branchName(...))`, then apply `claimed` with `patch.branch`. The claim is kept, because `apply` clears it, so re-claim after this apply.
  - For agent steps: `startRun`.
  - Build `context` from the current spec and plan docs, `answer` (as `feedback`) and the latest verify doc (as `checks`).
- **`complete`:**
  - Requires `claimBy === claimant` (a lapsed claim is still accepted if nobody has re-claimed the task) and `stage === step`.
  - Parse the result. On `done` with a `doc`, call `addDoc(kind = step, author = actor)`.
  - Call `finishRun`, add `costUsd` to the task, then apply `limit` if the new cost is over the maximum, and otherwise apply `agent`.
- **`check`:** requires the claim and stage `check`. Runs `runChecks`, writes `addDoc('verify', formatReport, 'core · checks')`, and applies `checks` with a `summary` made of the failing step names.
- **`ship`:**
  - Requires the claim and stage `ship`.
  - Calls `git.push(worktree, task.branch)`, then `openPr` with title `[${taskId}] ${title}` and a body made of `Factory task ${taskId}` plus the first 3000 characters of the current spec.
  - If `shouldMerge(base, gates.pr)`, it calls `mergePr` and applies `shipped merged`. Otherwise it applies `shipped` not merged with `prUrl`.

- [ ] **Step 1: Write the failing tests.** One test per behaviour above. Pin these:
  - `paused` → `next()` is `null`, and the store shows no claim.
  - With 2 tasks claimed by others and `maxParallel 2`, `next()` is `null`.
  - A `ready` task → the ticket step is `spec`, the task is `spec/spec`, and the events include `{field:'status', from:'ready', to:'spec'}`.
  - `complete` with another claimant's claim throws `ClaimError`, and `complete(…,'plan',…)` at stage `spec` throws `StageError`.
  - A spec approval at v1 after spec v2 exists leaves the task in `spec_review` after `sync()`.
  - Base `dev` with the PR gate off → `ship` leaves the task at `pr_open`, and `FakeGitHub` shows no merge.
  - Base `feature/x` with the PR gate off → the task is `done`, and `FakeGitHub` shows `merged`.
  - A PR closed on GitHub → after `sync()` the task is `blocked` with `blockedReason: 'PR closed without merge'`.
  - A cost of 5.01 at the default limit → `blocked`.
  - With fake timers, a `prState` that throws 3 times makes `sync()` resolve with the task still `pr_open` and the stub called 3 times. A `prState` that throws once and then returns `merged` gives `done`.
- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Commit.** Use the message `feat(core): engine for next, complete, check, ship and sync`.

---

### Task 12: `factory` CLI

**Files:**
- Create: `core/src/cli.ts` (the `#!/usr/bin/env node` entry) and `core/src/wire.ts`
- Test: `core/test/cli.test.ts`

**Interfaces:**
- Consumes: `Engine` and the ports.
- Produces:
  - `run(argv: string[], io: {out: (s: string) => void, err: (s: string) => void}, makeEngine?: (o: WireOptions) => Promise<{engine: Engine, store: BoardStore}>): Promise<number>`, which returns an exit code
  - `WireOptions {root: string, mode: Mode, store: 'file'|'blocks'}`
  - `wire(o: WireOptions)`, which builds the real deps:
    - `FileStore('<root>/.factory/board.json')`
    - `LocalGitRepos(root)`
    - an `OctokitGitHub` created on first use from `readSecret('github-pat')`
    - `shellExec`
    - the claimant `${mode}:${os.hostname()}` (or `FACTORY_CLAIMANT` if set)
  - `--store blocks` exits with code 2 and prints `Blocks store is not built yet (plan 2)`.
  - `root` is `FACTORY_ROOT`, or the nearest parent folder of the cwd that contains `repos/`.

**Commands:**
- Global options: `--mode sdk|loop|session` (default `session`) and `--store file|blocks` (default `file`).
- Engine commands:
  - `next [task] [--json]` prints the ticket as JSON, or `nothing to do` with exit code 0.
  - `complete <task> <step> --result <file>`. A missing file is passed on as `undefined`, so it becomes a `failed` result.
  - `check <task>`, `ship <task>`, and `status [--json]`.
- Dev-only commands, for the file store only, which stand in for the Board page until plan 3:
  - `dev add --repo <id> --title <t> [--description <d>] [--base <branch>]`
  - `dev ready <task>`
  - `dev approve <task> <gate> [--changes <comment>]`, which approves the current doc version for that gate
  - `dev answer <task> <text>`
  - `dev cancel <task>`
  - The ones that change a task use `assertMove(…, 'you')` and write events with the actor `you`.
- Errors (`IllegalMoveError`, `ClaimError`, `StageError`, `ProtectedBranchError`, `SecretMissingError`) print one line to stderr and exit with code 1. No stack traces.

- [ ] **Step 1: Write the failing tests** using `run` with an injected engine on `MemoryStore` and the fakes:
  - `next --json` prints a ticket whose `step` is `spec`.
  - `complete T-1 spec --result missing.json` gives exit 0, and the task is `blocked` with a `blockedReason` starting `invalid agent result`.
  - `dev approve T-1 plan` while the task is in `spec_review` exits 1 with `/no current plan doc/`.
  - `--store blocks status` exits 2.
  - `ship T-1` against a task whose branch would be `dev` exits 1 with a one-line `ProtectedBranchError` message.
- [ ] **Step 2: Run the tests.** Expected: FAIL. **Step 3:** Implement with commander. **Step 4:** Run the tests, then `npm run build && node dist/cli.js --help`. Expected: tests PASS, and the help lists `next`, `complete`, `check`, `ship`, `status` and `dev`.
- [ ] **Step 5: Commit.** Use the message `feat(core): factory CLI with dev board commands`.

---

### Task 13: Integration run (spec §11)

**Files:**
- Test: `core/test/integration.test.ts`

**Interfaces:**
- Consumes: `Engine`, `MemoryStore`, `LocalGitRepos`, `FakeGitHub`, `shellExec`, and a temp `RepoConfig` whose `remote` is a temp bare repo with a `dev` branch and whose check commands are `true`. The failure case switches `client.test` to `false`.

- [ ] **Step 1: Write the test "ready to pr_open with stubbed agents".**
  - Create the task, then mark it ready.
  - `next` → spec. Complete it with `{status:'done', summary:'s', doc:'# Spec'}`, and the task is at `spec_review`.
  - Add a spec approval at v1, then `next` → plan. Complete it with a doc, and the task is at `build` because the plan gate is off.
  - `next` → build. In the ticket's worktree, write `hello.txt` and `git commit` it, then complete with `done`.
  - `next` → check. Run `check`, then `next` → verify. Complete it with `verdict: 'pass'`.
  - `next` → review. Complete it with `verdict: 'approve'`, then `next` → ship, then `ship`.
  - Assert:
    - The status is `pr_open`, and `FakeGitHub.prs` has one PR with `base: 'dev'` and `head: 'factory/T-1-…'`.
    - `git ls-remote` shows the task branch, and the `dev` sha is unchanged.
    - `listEvents('T-1')` contains every status move in order, from `ready→spec` to `review→pr_open`.
  - Then call `setState(url, 'merged')` and `sync()`. The task is `done`.
- [ ] **Step 2: Write the test "checks fail three times → blocked".** Use the `false` client test. Loop build → check three times. After the third check the task is `blocked`, with `attempt 3` and `blockedReason: 'returned to build 3 times'`.
- [ ] **Step 3: Run the tests.** Run `npx vitest run test/integration.test.ts`. Expected: PASS. If anything fails, fix it in the task that owns the code.
- [ ] **Step 4: Run the full suite.** Run `npm test && npm run typecheck`. Expected: everything passes with no type errors.
- [ ] **Step 5: Commit.** Use the message `test(core): end-to-end run from ready to pr_open`.
