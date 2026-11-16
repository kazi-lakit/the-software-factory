# GitHub Integration Stage 2 (Push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tsf changes reach GitHub. For GitHub-only factories, the core creates an issue per task, keeps its Project Status, title and body in step, and posts spec, plan and blocked comments. `factory new` pushes at once, every state-changing CLI command pushes the task it touched, and `factory sync [--watch]` drains anything still waiting.

**Architecture:** A per-task **GitHub link record** stores what was last pushed. A pure **planner** compares the task (plus its current docs and the factory's `github` settings) with that record and returns an ordered list of push actions. A **pusher** runs those actions against `GitHubBoard` and saves the link record after each one. It has a lease (so two processes never push the same task) and backoff (so a failing task doesn't hammer GitHub). This derived outbox is always written "in the same write as the change": the change is the task row itself, so nothing can be lost between them (see "Builder's calls" below). Stage 2 pushes **github-only** factories on the file store only. Connected mode (Blocks) comes in stage 4.

**Tech Stack:** TypeScript (Node ≥22, ESM), vitest, commander, @octokit/rest, @noble/hashes.

**Spec:** `docs/superpowers/specs/2026-11-13-github-board-integration-design.md` (sections 5, 6, 7 for comment wording, 8.4 for `lastPushed`, 13 stage 2). Stage 1 plan: `docs/superpowers/plans/2026-11-14-github-integration-stage1.md`.

## Builder's calls (for the owner to check)

1. **Derived outbox instead of outbox rows.** Spec 6.2 says outbox rows; spec 14 leaves where the outbox lives to the builder "as long as it is written in the same write as the change it records". The task row *is* that change, and the link record holds what was last pushed, so the work left is always `diff(task, pushed)`. This gives the same guarantees: nothing is lost, actions are ordered per task, retries use backoff, a stuck task is shown, and there are no extra writes on any task change. It means no outbox table and no Blocks schema for one in stage 4. Cost if wrong: a later stage would add rows on top of the planner (the planner stays).
2. **The link is its own record, not a field on `Task`** (spec 6.1 says "the task stores `github`"). The pusher writing to the task would bump the task's version and make the engine's compare-and-set writes fail mid-step. A separate record keyed by `taskId` avoids that. Stage 4's card reads the record. `lastPushed` from spec 8.4 is the record's `pushed` field.
3. **Catching up posts only the current doc version.** If several spec versions were written while GitHub was unreachable (or before GitHub was turned on), only the current one is posted (`Spec v3`). The pull in stage 3 reads commands after the latest doc comment, so the earlier ones add only noise.
4. **Which commands push.** The "before and after each step" from spec 6.2 maps onto the CLI commands a step runs: `new`, `next` (when it hands out work), `complete`, `check`, `ship` and the `dev` stand-ins each push the task they touched. Push failures never fail the command. Pull before each step is stage 3.
5. **Turning GitHub on** for a factory with tasks: open tasks get issues on the next push; `done`/`cancelled` tasks without a link get none (spec 5). Turning it off pushes nothing; links are kept.

## Global Constraints

- The browser never holds a GitHub token. `board-ui` imports only `core/src/browser.ts`. New Node-only modules (`githubPusher.ts`) go on the `FORBIDDEN` list in `test/browser.test.ts`. `githubPush.ts` and `githubLink.ts` stay pure (no Node API, no credential).
- Agents never touch GitHub; only the core does. Nothing here is called from `plugin/` agent code.
- A factory with no `github` block behaves exactly as today: no link records, no GitHub calls, no new output.
- GitHub access goes through the factory's gh login (`ghUser`) via `GitHubBoardFor` (`lazyGitHubBoardFor` in `core/src/wire.ts`).
- The hidden marker is exactly `<!-- tsf:task=<taskId> factory=<factoryId> -->`, appended to the issue body (spec 6.1).
- Doc comment heading: `Spec v<N>` / `Plan v<N>`. With the gate on (github-only mode) it ends with: reply `/approve` to approve, or `/changes <what to change>` to send it back (spec 7).
- `cancelled` closes the issue as `not_planned`; `done` closes it as `completed` (spec 6.1).
- The label is always added when it isn't `''`; the core creates it in the repo if it's missing (spec 5).
- Error text shown anywhere goes through the doctor's token redaction (`[redacted]`).
- Ground rules: never push, never change git config or remotes. Commit on `dev` only when the controller says so.

## Review Focus

1. **A crash or failure right after `createIssue`.** For example, `addToProject` throws. The retry must not create a second issue: the issue number is saved before the next action runs. (Task 4, test `does not create a second issue after a later action fails`.)
2. **Watcher and CLI push the same task at once.** Only one creates the issue; the other skips on the lease. (Task 4, test `a held lease makes another pusher skip`.)
3. **The owner renamed or removed a Project column** that the status map uses. That task records the error and backs off. Other tasks still push. `factory status` shows the error. (Task 4 `an unknown Status option fails only that task`, Task 6 `status lists push errors`.)
4. **The gh login isn't logged in when running `factory new`.** The task is still created, the command exits 0, and stderr says `factory sync` will retry. (Task 6, test `new keeps the task when the push fails`.)
5. **A long-running `factory sync --watch` while the owner edits `factory.yaml`** (a status map change). The next tick uses the new map and pushes the Status again. (Task 2 `re-reads factory.yaml when it changes`, Task 7 integration.)

---

### Task 1: Board client additions and stage 1 leftovers

**Files:**
- Modify: `core/src/githubBoard.ts` (interface, `OctokitGitHubBoard`, `FakeGitHubBoard`)
- Modify: `core/src/wire.ts` (`LazyGitHubBoard`)
- Test: `core/test/githubBoard.test.ts`

**Interfaces:**
- Produces: `GitHubBoard.addLabels(r: RepoRef, number: number, labels: string[]): Promise<void>`. It adds the labels and keeps the issue's other labels (REST `issues.addLabels`). `listItems` skips null item nodes and items with null content. `listComments(r, n, since)` keeps comments whose `createdAt` is later than `since`, compared as dates (`Date.parse`), in both the Octokit and fake clients.

- [ ] **Step 1: Write the failing tests** in `test/githubBoard.test.ts`:
  - `addLabels keeps existing labels`: fake issue with labels `['bug']`, call `addLabels(r, n, ['factory'])`, and expect labels `['bug', 'factory']`. Adding `factory` again leaves one `factory`.
  - `Octokit addLabels posts to the labels endpoint`: using the fetch-stub style already in this file, expect `POST /repos/o/r/issues/7/labels` with body `{"labels":["factory"]}`.
  - `listItems skips null nodes`: a stubbed GraphQL page whose `nodes` is `[null, {id:'IT1', fieldValueByName:null, content:null}, <valid issue node>]` returns one item.
  - `listComments compares since as dates`: fake comments created at `2026-11-15T10:00:00Z` and `2026-11-15T10:00:01.500Z`; `since = '2026-11-15T10:00:00.000Z'` returns only the second.
- [ ] **Step 2: Run** `cd core && npx vitest run test/githubBoard.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `addLabels` in all three classes. Add the null guards in `listItems` (type `nodes` as `(Node | null)[]`). Change the `since` filter to `Date.parse(c.createdAt) > Date.parse(since)` in the Octokit and fake `listComments`. Octokit keeps passing `since` to the API as a coarse filter.
- [ ] **Step 4: Run** `npx vitest run test/githubBoard.test.ts test/wire.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A core && git commit -m "Add addLabels to the board client and harden listItems and listComments"`

### Task 2: GitHub link records in the store, and a fresh factory.yaml

**Files:**
- Create: `core/src/githubLink.ts` (pure types and helpers)
- Modify: `core/src/boardStore.ts`, `core/src/store.ts` (MemoryStore, FileStore), `core/src/blocks/store.ts`, `core/src/wire.ts` (`LazyBlocksStore`)
- Test: `core/test/store.test.ts`, `core/test/blocks/` (the BlocksStore test file that already exists for the store)

**Interfaces:**
- Produces, in `githubLink.ts`:
  ```ts
  export interface PushedState {
    status: Status | null; option: string | null; title: string | null; bodyHash: string | null; label: string | null;
    docs: { spec: number; plan: number }; blocked: string | null; closed: boolean;
  }
  export interface GitHubLink {
    taskId: string; factoryId: string;
    /** "owner/repo" of the issue's repo. */
    repo: string;
    issueNumber: number | null; issueNodeId: string | null;
    /** "owner/number" of the Project the item is on. */
    project: string | null; itemId: string | null;
    pushed: PushedState;
    error: { message: string; attempts: number; nextAttemptAt: string } | null;
    lease: { by: string; until: string } | null;
    version: number;
  }
  export const emptyPushed = (): PushedState => ({ status: null, option: null, title: null, bodyHash: null, label: null, docs: { spec: 0, plan: 0 }, blocked: null, closed: false });
  ```
- Produces, on `BoardStore`:
  - `listGitHubLinks(factoryId?: string): Promise<GitHubLink[]>`
  - `getGitHubLink(taskId: string): Promise<GitHubLink | undefined>`
  - `saveGitHubLink(before: GitHubLink | null, after: GitHubLink): Promise<GitHubLink>`. This is compare-and-set on `version`, with the same semantics as `saveFactoryDef` (reuse `versionedSave` in store.ts). It is core only: an `owner` identity throws `ForbiddenError`.
- MemoryStore/FileStore keep `githubLinks: GitHubLink[]` in `State` (default `[]`; old files load fine).
- BlocksStore: `listGitHubLinks` → `[]`, `getGitHubLink` → `undefined`, `saveGitHubLink` throws `ForbiddenError('GitHub links are not stored in Blocks yet (connected mode)')`. `LazyBlocksStore` forwards all three.
- FileStore re-reads `factory.yaml` files when any of them changed. Keep the stage 1 "read once per instance" caching, but key it on the newest mtime of `factories/*/factory.yaml` (plus the file count), so a long-running process sees edits and a bad file is still reported once per change.

- [ ] **Step 1: Write the failing tests** in `test/store.test.ts`. Run each one for `MemoryStore` and `FileStore` through a small `describe.each`:
  - `saveGitHubLink inserts at version 1 and lists by factory`: save one link for factory `a` and one for `b`. Expect `listGitHubLinks('a')` to return one link at version 1, `listGitHubLinks()` to return two, and `getGitHubLink('T-1')` to equal the saved link.
  - `saveGitHubLink is compare-and-set`: saving with a stale `before` throws `VersionConflictError`. Inserting a taskId that already exists throws `VersionConflictError`.
  - `owner identity may not save links`: `new MemoryStore({ identity: 'owner' })` throws `ForbiddenError`.
  - FileStore only, `a file without githubLinks loads`: write `{"tasks":[]}` to the path and expect `listGitHubLinks()` to be `[]`.
  - FileStore only, `re-reads factory.yaml when it changes`: create a store over a temp `factories/a/factory.yaml` with a `github` block whose `statusMap.ready` is `Todo`. Read the defs. Rewrite the file with `ready: Ready` and bump its mtime with `utimesSync` to +2 s. Expect `listFactoryDefs()` to show `Ready`.
  - Blocks test: `listGitHubLinks` returns `[]`, and `saveGitHubLink` rejects with `ForbiddenError`.
- [ ] **Step 2: Run** `npx vitest run test/store.test.ts test/blocks`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the interface additions, the stores, the Lazy forwarders and the mtime-keyed seeding in `FileStore.upgrade`.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: all PASS (the existing store contract is unchanged).
- [ ] **Step 5: Commit** `git commit -am "Store a GitHub link record per task and re-read changed factory.yaml files"` (also `git add` the new file).

### Task 3: Push planner (pure)

**Files:**
- Create: `core/src/githubPush.ts`
- Test: `core/test/githubPush.test.ts`

**Interfaces:**
- Consumes: `GitHubLink`, `PushedState`, `emptyPushed` (Task 2); `GitHubSettings` (`githubConfig.ts`); `Task`, `Doc`, `Gate` (`types.ts`).
- Produces:
  ```ts
  export const markerOf = (taskId: string, factoryId: string): string; // `<!-- tsf:task=${taskId} factory=${factoryId} -->`
  export function issueBody(description: string, taskId: string, factoryId: string): string; // description.trimEnd() + '\n\n' + marker; marker alone when the description is blank
  export function bodyHash(description: string): string; // sha256 hex of the description (@noble/hashes/sha2 + utils bytesToHex)
  export const projectKey = (p: ProjectRef): string; // `${owner}/${number}`
  export function blockedKey(t: Task): string | null; // null unless status === 'blocked'; else `${blockedReason ?? ''}\n${question ?? ''}`
  export type PushAction =
    | { kind: 'create'; title: string; body: string; labels: string[] }
    | { kind: 'addToProject' }
    | { kind: 'setStatus'; option: string }
    | { kind: 'addLabel'; label: string }
    | { kind: 'updateIssue'; title: string; body: string }
    | { kind: 'comment'; about: 'spec' | 'plan'; version: number; body: string }
    | { kind: 'comment'; about: 'blocked'; key: string; body: string }
    | { kind: 'close'; reason: 'completed' | 'not_planned' };
  export interface PushInput { task: Task; link: GitHubLink | undefined; settings: GitHubSettings; docs: { spec?: Doc; plan?: Doc }; gates: Record<Gate, boolean> }
  export function planPush(i: PushInput): PushAction[];
  ```
- Rules for `planPush`. Use `p = link?.pushed ?? emptyPushed()`, and let `created` mean `link?.issueNumber != null`:
  1. If not created and status is `done` or `cancelled`, return `[]`.
  2. If not created, add `create` with the title, `issueBody(...)` and `labels = settings.label === '' ? [] : [settings.label]`. Then treat `p.title`, `p.bodyHash` and `p.label` as already pushed (create carried them).
  3. Add `addToProject` when not created, `link.itemId` is null, or `link.project !== projectKey(settings.project)`.
  4. Add `setStatus` with `settings.statusMap[task.status]` when that differs from `p.option`, or when step 3 fired.
  5. Add `addLabel` when the label isn't `''` and differs from `p.label`.
  6. Add `updateIssue` when the title differs from `p.title`, or `bodyHash(description)` differs from `p.bodyHash`.
  7. For spec, then plan: add a `comment` when the current doc's version is greater than `p.docs[kind]`. The body is `` `## Spec v${n}\n\n${doc.body}` ``. When `settings.mode === 'github-only'` and `gates[kind]` is on, add `` `\n\n---\nReply \`/approve\` to approve, or \`/changes <what to change>\` to send it back.` ``.
  8. Add a blocked `comment` when `blockedKey(task)` isn't null and differs from `p.blocked`. The body is `` `**Blocked:** ${blockedReason ?? 'no reason given'}` ``, plus `` `\n\n**Question:** ${question}\n\nReply \`/answer <text>\` to answer.` `` when there is a question and the mode is github-only.
  9. Add `close` when the status is `done` (`completed`) or `cancelled` (`not_planned`) and `!p.closed`.

  The order is always the order of the rules above.

- [ ] **Step 1: Write the failing tests** in `test/githubPush.test.ts`. Use a `settings` fixture with mode `github-only`, project `o/3`, label `factory`, and the statusMap from spec 5. Tests:
  - `a new inbox task: create, addToProject, setStatus Backlog`: expect exactly the kinds `['create','addToProject','setStatus']`. Expect `create.body` to end with `<!-- tsf:task=T-1 factory=f -->`, labels `['factory']`, and option `Backlog`.
  - `label '' creates with no labels and never adds one`.
  - `blank description: body is the marker alone`.
  - `nothing changed: no actions`. The link has pushed equal to the task's current state.
  - `status change maps through statusMap; spec and spec_review sharing an option push nothing`.
  - `edited statusMap re-pushes Status`: `p.option = 'Todo'`, and the map now says `ready: Ready`. Expect one `setStatus Ready`.
  - `changed project re-adds the item and sets Status`: link.project `o/2`, settings `o/3`. Expect `['addToProject','setStatus']`.
  - `new label is added`: `p.label = 'old'`. Expect `addLabel factory`.
  - `title or description edit: updateIssue with marker kept`.
  - `spec v2 with gate on: one comment with heading and reply line`. `p.docs.spec = 0`, the current spec is v2. Expect one comment, starting `## Spec v2`, containing `/approve`.
  - `spec comment without the reply line when the gate is off or mode is connected`.
  - `blocked with question: comment with /answer line; same block again: nothing`.
  - `cancelled: setStatus Backlog then close not_planned`. `done`: close `completed`. Already closed: nothing.
  - `a done task never pushed: no actions`.
  - `bodyHash is stable sha256 hex`: `bodyHash('abc')` equals `'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'`.
- [ ] **Step 2: Run** `npx vitest run test/githubPush.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `githubPush.ts`.
- [ ] **Step 4: Run** the same test plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Plan GitHub pushes from the task and its last pushed state"` (after `git add`).

### Task 4: Pusher

**Files:**
- Create: `core/src/githubPusher.ts`
- Modify: `core/src/doctor.ts` (export the redaction as `redactSecrets(s: string): string`; keep using it inside)
- Modify: `core/test/browser.test.ts` (add `githubPusher` to `FORBIDDEN`)
- Test: `core/test/githubPusher.test.ts`

**Interfaces:**
- Consumes: `planPush`, `blockedKey`, `projectKey`, `bodyHash` (Task 3); the link store methods (Task 2); `GitHubBoard.addLabels` (Task 1); `parseRemote` (`remote.ts`); `resolveSettings`, `resolveGates` (`gates.ts`); `DEFAULT_SETTINGS`.
- Produces:
  ```ts
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
  export class GitHubPusher {
    constructor(deps: PusherDeps);
    pushTask(taskId: string, opts?: { ignoreBackoff?: boolean }): Promise<PushResult>;
    /** Every task of every github-only factory (or only `factoryIds`), one at a time, by task id. */
    pushAll(factoryIds?: string[]): Promise<PushResult[]>;
  }
  export const LEASE_MS = 60_000;
  export const backoffMs = (attempts: number): number => Math.min(5_000 * 2 ** (attempts - 1), 600_000);
  ```
- Behaviour of `pushTask`:
  - `skipped: 'not-github'` when the task's factory has no `github` block, or its mode isn't `github-only` (connected comes in stage 4).
  - The issue repo comes from the task's `FactoryRepo.remote` via `parseRemote` (`link.repo = "owner/repo"`).
  - Return `skipped: 'backoff'` (no GitHub call) when the link's `error.nextAttemptAt` is later than now and not `ignoreBackoff`.
  - Run `planPush`. Gates come from `resolveGates(resolveSettings(stored factory settings ?? DEFAULT_SETTINGS, repo settings), task.gateOverrides)`. Docs come from `store.currentDoc(taskId, 'spec' | 'plan')`. With no actions and nothing to clear, return without writing anything. "Nothing to clear" means no `error`, and `pushed.blocked` already equals `blockedKey(task)`.
  - Take the lease with `saveGitHubLink` (insert a new link, or CAS with `lease: { by: claimant, until: now + LEASE_MS }`). If a `VersionConflictError` occurs, or another claimant holds an unexpired lease, return `skipped: 'leased'`.
  - Resolve the Project once per call with `board.project(settings.project)`. If it returns null, the error is `Project <owner>/<n> not found`.
  - Before `create` or `addLabel`, make sure the label exists in the repo: `labelExists`, then `createLabel` if needed.
  - Run the actions in order. After each one, update `pushed` (or `issueNumber`/`issueNodeId`, or `project`/`itemId`) and save the link (CAS), so a later failure keeps the progress already made. Action effects:
    - `create`: set issueNumber, issueNodeId, pushed.title, bodyHash and label.
    - `addToProject`: set itemId and project.
    - `setStatus`: set pushed.status and option.
    - `addLabel`: set pushed.label.
    - `updateIssue`: set pushed.title and bodyHash.
    - spec/plan comment: set pushed.docs[kind].
    - blocked comment: set pushed.blocked.
    - `close`: set pushed.closed and pushed.status.
  - On success, save the link with `error: null`, `lease: null` and `pushed.blocked = blockedKey(task)`.
  - On failure, save the link with `error = { message: redactSecrets(first line), attempts: prev + 1, nextAttemptAt: now + backoffMs(attempts) }` and `lease: null`, then return `error`. Never throw for a GitHub error.

- [ ] **Step 1: Write the failing tests** in `test/githubPusher.test.ts`. Use a `MemoryStore` with a github-only factory `f` (repo remote `git@github.com:o/app.git`), and a `FakeGitHubBoard` with project `o/3` that has the spec 5 options. Tests:
  - `pushes a new task: issue, label created, item with Status`. Expect `issue: 'o/app#1'`, the fake issue to have label `factory` and its body to have the marker, its item status to be `Backlog`, and the link at `pushed.option = 'Backlog'`.
  - `second push with no change writes nothing`. The link version is unchanged.
  - `does not create a second issue after a later action fails`. Make `addToProject` throw once. First push: `error` set, issueNumber saved, attempts 1. Second push (`ignoreBackoff`): no new issue, and the item gets added.
  - `an unknown Status option fails only that task`. Task A's status maps to `Nope`, while task B is fine. `pushAll()` returns an error for A and success for B. A's link `error.nextAttemptAt` is now + 5 s.
  - `backoff skips until nextAttemptAt`. After a failure, `pushTask` returns `skipped: 'backoff'` and makes no board call.
  - `a held lease makes another pusher skip`. Pusher X's link has a lease by `x` until now + 60 s. Pusher `y` returns `skipped: 'leased'`. An expired lease is taken.
  - `factory without github: not-github, no link written`. Same for mode `connected`.
  - `cancelled task: Status Backlog and issue closed not_planned`.
  - `spec comment carries the reply line when the spec gate is on`. Store settings with spec gate on, add a spec doc v1, and move the task to spec_review. Expect the fake issue's last comment to start `## Spec v1` and contain `/approve`.
  - `error text is redacted`. The board throws `Error('bad ghp_' + 'a'.repeat(36))`, and the link's error contains `[redacted]`.
- [ ] **Step 2: Run** `npx vitest run test/githubPusher.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `githubPusher.ts`, the `redactSecrets` export, and the browser `FORBIDDEN` entry.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Push tasks to GitHub issues and Projects with lease and backoff"` (after `git add`).

### Task 5: PR body links the issue

**Files:**
- Modify: `core/src/engine.ts` (`openPr`, around line 481)
- Test: `core/test/engine.test.ts`

**Interfaces:**
- Consumes: `store.getGitHubLink` (Task 2), `parseRemote`.
- Behaviour: when the task has a link with an `issueNumber`, and `link.repo` equals the PR repo (`parseRemote(cfg.remote)`, compared case-insensitively as `owner/repo`), the PR body gets `\n\nCloses #<n>` appended. A failed link read (or no link) leaves the body as today.

- [ ] **Step 1: Write the failing tests** in `test/engine.test.ts`, using the existing ship test setup and fake `GitHub`:
  - `ship adds Closes #n when the task has an issue`. Save a link `{ repo: '<owner/repo of the fixture remote>', issueNumber: 12, ... }` and ship. Expect the fake's `openPr` body to end with `Closes #12`.
  - `ship body unchanged without a link`.
- [ ] **Step 2: Run** `npx vitest run test/engine.test.ts`. Expected: the first test FAILs.
- [ ] **Step 3: Implement** in `openPr` (read the link with the existing `retry`, and treat a rejection as no link).
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Link the task's issue from the PR body"`

### Task 6: CLI: push on new and after steps, `factory sync [--watch]`, status errors

**Files:**
- Modify: `core/src/cli.ts`
- Modify: `plugin/skills/run/SKILL.md` (one sentence: the core pushes task changes to GitHub for factories with a `github` block; the agent does nothing for it)
- Modify: `plugin/README.md` (CLI list: add `factory sync [--watch]`)
- Test: `core/test/cli.test.ts`

**Interfaces:**
- Consumes: `GitHubPusher`, `PushResult` (Task 4); `CliDeps.githubBoardFor` (already there).
- New `CliDeps` fields: `sleep?: (ms: number) => Promise<void>` and `watchTicks?: number` (tests: stop after N passes). The default is to run until SIGINT/SIGTERM, which ends after the current pass with exit 0.
- Pushing only happens with `--store file`. On `--store blocks`, no pusher is made and `factory sync` exits 1 with `factory sync needs --store file until connected mode is built`.
- A helper `pushAfter(store, taskId)` builds `new GitHubPusher({ store, boardFor, now, claimant: \`cli:${hostname()}\` })` and calls `pushTask`. It prints nothing on success or skip. On error it prints `github: <taskId> not pushed (<error>); factory sync retries` to stderr, and the exit code is unchanged. It's called after `new`, `next` (only when the outcome is `work`), `complete`, `check`, `ship`, `dev add`, `dev ready`, `dev approve`, `dev answer` and `dev cancel`.
- `factory new` without `--json` also prints `<taskId> issue <owner/repo#n>` on stdout when the push created the issue.
- `factory sync [--factory <id>...] [--watch] [--interval <seconds>]`. The interval defaults to 5, and must be a whole number from 1 to 3600, else exit 1.
  - One pass is `pushAll(factories)` with `ignoreBackoff: false`. Print `<taskId> <issue ?? '-'>: <done joined by ', '>` for each result with actions, and `FAIL <taskId>: <error>` for each error. End with `pushed <n>, failed <m>`.
  - With no github-only factory, print `no factory uses GitHub-only mode` and exit 0.
  - Without `--watch`, exit 1 when any task failed.
  - With `--watch`, print only lines for results with actions or errors (no summary), sleep `interval` seconds between passes, and keep going after errors. A pass that throws (for example, the store is locked) prints `error: <first line>` and the watch continues.
- `factory status` lists every link with an `error` as `github: <taskId> push failing (<message>), attempt <n>, next try <nextAttemptAt>`. With `--json` they go under a top-level `githubErrors: [{ taskId, message, attempts, nextAttemptAt }]`.

- [ ] **Step 1: Write the failing tests** in `test/cli.test.ts`. Use the existing `run(argv, io, makeEngine, deps)` style with a MemoryStore-backed `makeEngine`, a github-only factory, and `deps.githubBoardFor = () => fake`. Tests:
  - `new pushes at once and prints the issue`: stdout has `T-1 created in inbox` and `T-1 issue o/app#1`, and the fake has the issue.
  - `new keeps the task when the push fails`: the fake board's `project` throws `GhLoginMissingError('kazi-lakit')`. Exit 0, the task exists, and stderr has `github: T-1 not pushed (` and `factory sync retries`.
  - `new on a factory without github prints no issue line and makes no board call`.
  - `dev cancel pushes the close`: after `new` and `dev cancel T-1`, the fake issue is closed `not_planned`.
  - `sync pushes waiting tasks and summarises`: create a task directly in the store (Board-style), run `sync`, expect `T-1 o/app#1: created, status Backlog` and `pushed 1, failed 0`, exit 0.
  - `sync exits 1 when a task fails`, and its output has `FAIL T-1:`.
  - `sync with no github-only factory`: prints `no factory uses GitHub-only mode`, exit 0.
  - `sync --watch runs passes until watchTicks`: `watchTicks: 2` with a fake `sleep` that records `5000`. A task created between ticks (from inside the `sleep` stub) is pushed on tick 2.
  - `sync --interval 0 is refused`: exit 1.
  - `sync on the blocks store is refused`: exit 1 with the message above.
  - `status lists push errors`: a saved link with an error. Text output has the `github: T-1 push failing (` line, and JSON has `githubErrors[0].attempts`.
- [ ] **Step 2: Run** `npx vitest run test/cli.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the CLI changes and the two plugin doc lines.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`, and `cd ../plugin && npx vitest run` (guard tests unaffected). Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Push from factory new and each step, add factory sync --watch, show push errors"` (after `git add`).

### Task 7: End-to-end push test on the file store, and the manual check

**Files:**
- Test: `core/test/integration.test.ts` (new `describe('GitHub-only push')`)
- Modify: `docs/superpowers/specs/2026-11-13-github-board-integration-design.md`. Add one line under section 6.2: "Stage 2 build: derived outbox and separate link record, see the stage 2 plan's builder's calls."

**Interfaces:**
- Consumes: everything above, through `run()` from `cli.ts` with a real `FileStore` in a temp factory root (`FACTORY_ROOT`), `factories/f/factory.yaml` with a github-only block, and `deps.githubBoardFor` returning one `FakeGitHubBoard`.

- [ ] **Step 1: Write the test** `GitHub-only push follows a task from new to cancelled`:
  1. `new --repo app --title A --description D`: the issue has label `factory`, the body ends with the marker, and Status is `Backlog`.
  2. `dev ready T-1`: Status is `Todo`.
  3. Write a spec doc and move to `spec_review` directly through a second `FileStore` on the same file (as the engine would), then `sync`: one comment starting `## Spec v1`, with Status `In progress`.
  4. Rewrite `factory.yaml` with `spec_review: In review` (bump the mtime), then `sync`: Status is `In review`, with no second comment.
  5. `dev cancel T-1`: the issue is closed `not_planned` and Status is `Backlog`.
  6. `sync` again: `pushed 0, failed 0` and the link version is unchanged.
- [ ] **Step 2: Run** `npx vitest run test/integration.test.ts`. Expected: PASS. If it fails, fix the owning task's code, not the test's expectations.
- [ ] **Step 3: Run the full suite** `npx vitest run && npm run typecheck`. Expected: all PASS.
- [ ] **Step 4: Commit** `git commit -am "Test the GitHub-only push end to end on the file store"`
- [ ] **Step 5 (owner, manual, before stage 3 starts):** against a throwaway Project, add the `github` block to a real factory and run `factory doctor --factory <id>`. Then run `factory new --repo <r> --title "push test" --description x`, `factory dev ready <id>` and `factory dev cancel <id>`. Check the issue, label, Status moves and close on GitHub.
