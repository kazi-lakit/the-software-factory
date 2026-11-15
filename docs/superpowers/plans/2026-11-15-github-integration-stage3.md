# GitHub Integration Stage 3 (Pull) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub changes reach tsf in GitHub-only mode. Before each factory step and on each `factory sync` pass, the core reads the Project and applies the spec 8.3 rules. It turns `/approve`, `/changes`, `/answer` and `/unblock` comments, and PR reviews, into the same records the Board writes. `factory sync --rebuild` restores a lost `board.json` from GitHub. A factory then runs end to end from GitHub alone (spec 10).

**Architecture:** The pull has three layers. Stage 4 reuses the first two.
1. A pure **planner** (`githubPull.ts`) takes what was read from GitHub, plus the factory's tasks, links, doc versions and approvals. It returns a **change set**: owner actions, each carrying the task id and the version it was worked out against, plus "not applied" items.
2. A pure **applier** (`githubPullApply.ts`) runs a change set through the owner functions in `owner.ts`, with version checks and `github` as the event actor.
3. A Node **puller** (`githubPuller.ts`) does the GitHub reads, calls the planner and the applier, writes the link records, and reacts 👍 to the comments it used.

The CLI pulls before `factory next` (with or without `--peek`). Each `factory sync` pass is pull then push. Connected mode (the Board applies, sync requests, Blocks schema) is stage 4.

**Tech Stack:** TypeScript (Node ≥22, ESM), vitest, commander, @octokit/rest, @noble/hashes.

**Spec:** `docs/superpowers/specs/2026-11-13-github-board-integration-design.md` (sections 7, 8, 10, 13 stage 3). Stage 2 plan (style, existing pieces): `docs/superpowers/plans/2026-11-15-github-integration-stage2.md`. Stage 2 leftovers: `runs/design/stage3-inputs.md` (all eight are folded in below: 1→T2, 2→T1, 3→T2, 4→T2, 5→T3, 6→T2, 7→T10, 8→T2/T5/T11).

## Builder's calls (for the owner to check)

1. **The change set.** The type is `PullPlan { factoryId, actions: PullAction[], notApplied: NotApplied[] }`. Every action except `create` carries `taskId`, `version` and `issue`. The planner is a pure function of its input, and so is the applier, which uses only the store. Stage 4's watcher computes the plan and its Board runs `applyPull` with the same plan. Two parts are core-only, and in stage 4 the factory machine does them, not the Board: the `block` action (label removed; the owner has no right to block a task) and the link patches (`onApplied`, `NotApplied.link`). Cost if wrong: stage 4 has to split the plan type.
2. **"Not applied" items** are `{ taskId | null, issue: "o/r#n", change, reason }`. They are printed on every pull and never fail a command. One exception keeps the output quiet: "title/body edited after ready" is reported once per distinct edit, using `link.reported`, because the issue is not reverted, so the edit would otherwise show on every pull. When a Status move is not applied, the planner also sets `pushed.option` to the observed option, so the next push puts the Status back (spec 8.3). Cost if wrong: noisy or silent output, and no data risk.
3. **Unblocking.** `/answer <text>` and `/unblock [text]` both go through `answerTask`. `/unblock` with no text answers `unblocked by <login>`. The engine then resumes the task at its stage, as it does for a Board answer. A blocked task with no stage (rebuilt tasks, and some limit blocks) resumes through a new core move `blocked → ready`: machine input `restart` (attempt 0; question, reason and answer cleared). It runs only for factories whose `github.mode` is `github-only`, so Board factories behave exactly as today. A task resumed at an agent stage gets the answer text as feedback ("unblocked by x"), which is harmless. A `restart` starts fresh from ready: the answer is not passed to the next agent and is recorded only in the task's events. Cost if wrong: an answer meant as instructions for a restarted task is not seen by its agents; no data risk.
4. **"After the latest doc comment".** The pusher stores the `createdAt` GitHub returns for each comment it posts: `pushed.docAt.spec`, `pushed.docAt.plan` and `pushed.blockedAt`. Commands are read only when the task's current doc version (or current block) has been pushed, and only comments created after that time. A doc that hasn't been posted yet has no comments to answer it. Cost if wrong: a command can be missed until the comment is pushed, and nothing is ever applied wrongly.
5. **Pull triggers (GitHub-only).** `factory next` pulls before the engine runs, both when claiming and with `--peek` (otherwise the watcher would never see a new Todo issue). Each `factory sync` pass and each `--watch` tick runs pull then push. `complete`, `check`, `ship`, `new` and `dev *` only push, because they run mid-step. A failed pull never fails `next`.
6. **Rebuild.** `factory sync --rebuild [--factory <id>...]` runs only for a GitHub-only factory with no tasks and no links in the store; otherwise it exits 1. It reads the open Project issues in the factory's repos whose marker names this factory, and restores each task under its marker id with the new core-only `store.restoreTask`. Status comes from the inverse of the status map over non-terminal statuses, and is used only when that option is unique **and** the status is `inbox`, `ready`, `spec_review` (with a `Spec vN` comment) or `plan_review` (with a `Plan vN` comment). Every other task is `blocked`, with stage null and reason `rebuilt from GitHub, check status`. The latest `Spec vN` / `Plan vN` comments become doc v1 in the store. The link records `pushed.docs` = 1 and `docAt`, so nothing is posted twice and `/approve` works at once. Then a normal push pass runs, which posts the blocked comment with its `/unblock` line. A unique status that needs state the core can't rebuild (working steps, `pr_open` without a PR URL) is not restored on purpose. Cost if wrong: the owner `/unblock`s such a task and it starts again from ready.
7. **CLI output.** Each pull line starts with the task. `T-3 created from o/app#4 (ready)`, `T-3 o/app#4: <change>`, `NOT APPLIED T-3 o/app#4: <change> (<reason>)` and `PULL FAIL T-3 o/app#4: <message>`, with `-` for a missing task or issue. `sync` prints them on stdout, followed by `pulled: created <c>, applied <a>, not applied <n>, failed <f>`, then the push lines as today. `next` prints them on stderr, each prefixed with `github: `, and prints no summary, because stdout is the ticket and the run skill parses it. `--watch` prints only the item lines, never a NOT APPLIED line it already printed in that process, and no summary.
8. **Source `github`.** This is the event `actor`: `github` for card moves, issue edits, closes and labels; `github · <login>` for commands and reviews. Each owner function in `owner.ts` gains an optional trailing `by?: OwnerBy` (`{ actor: string; reason?: string }`). The default stays `you`, so the Board is unchanged.
9. **PR gate reviews.** Only reviews from an approver, in state `APPROVED` or `CHANGES_REQUESTED`, on the PR's current head commit count. The latest one becomes the `pr` decision at the current `review` doc version. A re-ship pushes new commits, so old reviews stop counting by themselves. Reviews get no 👍 (the review is visible on the PR). GitHub doesn't let the PR author (the factory's `ghUser`) approve their own PR, so with the default `approvers: [ghUser]` the owner merges in GitHub instead, and the merge already moves the task to `done`. Merged → `done` and closed → blocked `PR closed without merge` already work in `engine.syncGate` and are unchanged.
10. **One pull per factory at a time.** This is an exclusive lock file `.factory/pull-<factoryId>.lock`, stale after 120 s. It stops a watcher tick and a `next` from both creating a task for the same new issue. A held lock skips that factory's pull silently on `next`; `sync` prints `github: pull of <f> skipped (another pull is running)`.
11. **Echo, and normalised bodies.** A GitHub value equal to the tsf value is never a change. Bodies are compared after CRLF → LF, with the marker removed and trailing space trimmed. `pushed.bodyHash` now hashes exactly the visible text the core wrote (`issueText`), so each existing issue gets one extra body update after the upgrade. A pulled edit whose body lost the marker leaves `pushed.bodyHash` null, so the next push writes the marker back.
12. **Issues in other repos.** An issue in a repo owned by another factory is ignored without a word. A labelled issue in a repo that no factory owns is reported once per pull as not applied: `repo o/x is not one of factory f's repos`.

## Global Constraints

- The browser never holds a GitHub token. `githubPull.ts` and `githubPullApply.ts` are pure: no Node API, no credential, only type imports from `githubBoard.ts` and `github.ts`. `browser.ts` exports them for stage 4. `githubPuller.ts` goes on the `FORBIDDEN` list in `test/browser.test.ts`.
- Agents never touch GitHub; only the core does. Nothing in `plugin/` agent code calls the pull.
- A factory with no `github` block behaves exactly as today: no pull, no GitHub calls, no new output, no new moves (the `restart` move is gated on `github-only`).
- Every pulled change goes through the owner functions in `owner.ts` with a version check (spec 8.3), except `block`, which is a core move through `assertMove(…, 'core')`. A pull never runs an agent, and it writes approvals only through `/approve` / `/changes` comments and PR reviews (spec 8.3, 7).
- Labels and card drags never answer a gate (spec 7). `/approve` comments are read only in `github-only` mode (spec 7, last bullet).
- Commands come from logins on `github.approvers`, compared case-insensitively, and only from comments created after the latest doc comment (or blocked comment). The first valid one wins (spec 7).
- Marker: `<!-- tsf:task=<taskId> factory=<factoryId> -->` (spec 6.1). Rebuild reason: exactly `rebuilt from GitHub, check status`. Label rule reason: exactly `label removed`. PR closed reason: exactly `PR closed without merge` (spec 8.3, 8.5, 7).
- Error text goes through `redactSecrets`. Pull, rebuild and the CLI only use `--store file`. On `--store blocks`, `sync` exits 1 as today and `next` doesn't pull.
- The owner's shell has `FACTORY_STORE=blocks`, so every test that calls `run()` passes `--store file`.
- Ground rules: never push, never change git config or remotes. Commit on the current branch only.

## Review Focus

1. **A watcher tick and a `next` pull at the same moment** while a new Todo issue exists. Exactly one task is created. (Task 8, `a held pull lock skips the factory`; Task 10, `next pulls while the lock is free and skips when held`.)
2. **A PR merged with `Closes #n`** closes the issue before the engine has seen the merge. The task must become `done`, not `cancelled`. (Task 6, `a closed issue whose PR merged is left to the engine`; Task 11 end to end.)
3. **An issue body edited in the GitHub web UI** comes back with CRLF line ends or a trailing newline but the same text. This is neither an edit nor a "not applied". (Task 6, `CRLF and trailing space are not an edit`.)
4. **The same `/approve`, or the same PR approval, read by two pulls** before the engine consumes it (for example, a PR approved on a protected base waits for the owner's merge). The result is one approval and one event. (Task 6, `a decision already recorded is not planned again`.)
5. **GitHub is unreachable or the gh login is logged out during `factory next`.** `next` still syncs and hands out work, and stderr has one `github: pull failed (…)` line. (Task 10, `next still works when the pull fails`.)

---

### Task 1: Link fields, issue text helpers and blocked comment

**Files:**
- Modify: `core/src/githubLink.ts`, `core/src/githubPush.ts`, `core/src/store.ts` (MemoryStore `listGitHubLinks`/`getGitHubLink` return `withLinkDefaults`)
- Test: `core/test/githubPush.test.ts`, `core/test/store.test.ts`

**Interfaces:**
- Produces, in `githubLink.ts`:
  - `PushedState` gains `docAt: { spec: string | null; plan: string | null }` and `blockedAt: string | null`. `GitHubLink` gains `reported: string[]` (at most 20 entries, oldest dropped).
  - `emptyPushed()` sets them to null.
  - `withLinkDefaults(l: GitHubLink): GitHubLink` fills missing fields, so links saved by stage 2 load fine.
- Produces, in `githubPush.ts`:
  - `issueText(description: string, taskId: string, factoryId: string): string`: the capped description as written on GitHub, so `issueBody` = `issueText` + `\n\n` + marker. `issueBody` is rebuilt on top of it.
  - `stripMarker(body: string): string`: CRLF → LF, every `<!-- tsf:task=\S+ factory=\S+ -->` removed, then `trimEnd()`.
  - `markerIn(body: string): { taskId: string; factoryId: string } | null`: the last marker in the body.
- `planPush` changes:
  - Rule 6 compares `bodyHash(issueText(...))` with `p.bodyHash`. The pusher stores `bodyHash(issueText(...))` (Task 2).
  - Rule 8: the blocked comment body goes through `capText`. In github-only mode it ends with ``\n\nReply `/answer <text>` to answer, or `/unblock` to resume.`` when there is a question, else with ``\n\nReply `/unblock` to resume.``

- [ ] **Step 1: Write the failing tests.**
  - In `githubPush.test.ts`:
    - `stripMarker normalises CRLF, drops the marker and trailing space`: `stripMarker('a\r\nb  \n\n<!-- tsf:task=T-1 factory=f -->\n')` equals `'a\nb'`.
    - `markerIn finds the marker`: returns `{ taskId: 'T-1', factoryId: 'f' }`, or null without one.
    - `issueBody is issueText plus the marker`.
    - `a description with trailing newline pushes nothing more once pushed`: the link has `bodyHash(issueText('D\n',…))`, and there are no actions.
    - `blocked comment is capped`: a reason of 70,000 chars gives a body of at most 65,000 chars, ending with the reply line.
    - `blocked without question asks for /unblock; with question for /answer or /unblock`.
  - In `store.test.ts` (both stores): `a stage 2 link loads with defaults`. Write a link without `docAt`, `blockedAt` and `reported` into the state, and expect `pushed.docAt` `{spec:null,plan:null}` and `reported` `[]`.
- [ ] **Step 2: Run** `cd core && npx vitest run test/githubPush.test.ts test/store.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the fields, the helpers, `withLinkDefaults` in the MemoryStore read paths (the FileStore inherits them), and the two `planPush` changes.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS. Update stage 2 test expectations only where they assert a raw-description hash.
- [ ] **Step 5: Commit** `git commit -am "Normalise issue text, add comment times to the link and cap the blocked comment"`

### Task 2: Pusher leftovers and comment times

**Files:**
- Modify: `core/src/githubConfig.ts`, `core/src/githubPusher.ts`
- Test: `core/test/githubConfig.test.ts`, `core/test/githubPusher.test.ts`

**Interfaces:**
- Consumes: Task 1 fields and helpers; `GitHubBoard.listItems`.
- Produces:
  - `GitHubConfigProblem` gains `clashWith?: { factoryId: string; repoId: string }`, set on the "already used by" problem. The pusher matches the clash on `clashWith` (both sides of the clash fail), not on the message text.
- Behaviour changes in `GitHubPusher`:
  - Comment and body effects:
    - A spec/plan comment saves `pushed.docAt[kind] = comment.createdAt`.
    - A blocked comment saves `pushed.blockedAt = comment.createdAt`.
    - `create` and `updateIssue` save `bodyHash(issueText(...))`.
  - Config checks (clash, missing repo, bad remote) are skipped for a task that is `link?.pushed.closed`, or that has no link and is `done`/`cancelled`. Such a task returns early with no write.
  - `pushAll` reads defs, repos, stored settings, links and tasks once per pass and passes them to `push`. Terminal tasks with no link, or with a closed link, are skipped without reading docs.
  - **Adopt before create.** Before running a `create` action, the pusher lists the Project items once per pass (cached like `project`). If an open or closed issue in the same repo has `markerIn(body)` equal to this task and factory, it is adopted: save `issueNumber`, `issueNodeId`, `itemId` and `project`, and set `pushed.title`/`bodyHash`/`label` from the issue. No `createIssue` call is made, and the remaining actions run.
  - **Leftover 8.** The action's phrase is pushed onto `result.done` right after the GitHub call succeeds, before its link save. A `VersionConflictError` on the final success save returns the result with `error: null`, because the actions are done and the next push re-plans.

- [ ] **Step 1: Write the failing tests.**
  - In `githubConfig.test.ts`:
    - `clash problem carries clashWith`: two factories on `o/app` give a problem for the second one with `clashWith: { factoryId: 'a', repoId: 'app' }`.
  - In `githubPusher.test.ts`:
    - `both sides of a repo clash fail`: neither task gets an issue.
    - `a done task never pushed with a clashing repo writes no link`.
    - `spec comment stores docAt; blocked comment stores blockedAt`: each equals the fake comment's `createdAt`.
    - `an issue carrying the marker is adopted, not created again`: create the issue in the fake with the task's marker and add it to the project. The push makes no new issue, and the link has that issue number.
    - `phrase kept when the link save after a GitHub call fails`: wrap the store so the save after `setStatus` throws once. Expect `done` to contain `status Backlog` and `error` to be set.
    - `final save conflict is not an error`.
    - `pushAll reads the factory defs once per pass`: a spy store counts `listFactoryDefs` calls, `1` for three tasks.
- [ ] **Step 2: Run** `npx vitest run test/githubConfig.test.ts test/githubPusher.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Pusher: structured clash, skip closed tasks, one snapshot per pass, adopt marked issues, store comment times"`

### Task 3: PR reviews in the GitHub client; new token after a 401

**Files:**
- Modify: `core/src/github.ts` (interface, `OctokitGitHub`, `FakeGitHub`), `core/src/wire.ts` (`LazyGitHub`, `LazyGitHubBoard`, `LoadOnce`)
- Test: `core/test/github.test.ts`, `core/test/wire.test.ts`

**Interfaces:**
- Produces, in `github.ts`:
  ```ts
  export interface PrReview { id: number; author: string; state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'; body: string; submittedAt: string | null; commitId: string | null }
  // on GitHub:
  prReviews(url: string): Promise<{ headSha: string; reviews: PrReview[] }>;
  ```
  - Octokit: `pulls.get` for `head.sha`, then `paginate(pulls.listReviews)`. States are lower-cased.
  - `FakeGitHub`: each PR gets `headSha: 'sha-<n>-1'` and `reviews: PrReview[]`. `addReview(url, r: { author: string; state: PrReview['state']; body?: string; commitId?: string }): PrReview` uses increasing ids and defaults `commitId` to the current head. `newHead(url): string` bumps the head to `sha-<n>-<k>`.
- `LoadOnce` gains `reset()`. `LazyGitHub` and `LazyGitHubBoard` call it when a call rejects with an error whose `status` is 401, so the next call reads the token again and `gh auth login` takes effect without a restart. The error is rethrown.

- [ ] **Step 1: Write the failing tests.**
  - In `github.test.ts`:
    - `Octokit prReviews returns head sha and reviews`: stub `GET /repos/o/r/pulls/7` and `GET /repos/o/r/pulls/7/reviews` in the file's fetch-stub style. Expect `state: 'approved'` and `commitId`.
    - `FakeGitHub reviews default to the head commit; newHead moves it`.
  - In `wire.test.ts`:
    - `a 401 makes the next call read the token again`: `make` returns a client whose first `prState` rejects with `Object.assign(new Error('Bad credentials'), { status: 401 })`. Two calls give two `read` calls. A 500 does not reset.
- [ ] **Step 2: Run** `npx vitest run test/github.test.ts test/wire.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the method in all three classes, the `LazyGitHub` forwarder, and the 401 reset.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Read PR reviews; read the gh token again after a 401"`

### Task 4: Owner functions record who acted; create from an issue

**Files:**
- Modify: `core/src/owner.ts`
- Test: `core/test/owner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OwnerBy { actor: string; reason?: string }
  export const GITHUB_ACTOR = 'github';
  export const githubActor = (login?: string): string => (login ? `github · ${login}` : GITHUB_ACTOR);
  markReady(store, now, taskId, by?: OwnerBy)
  cancelTask(store, now, taskId, by?: OwnerBy)
  answerTask(store, now, taskId, text, seenVersion, by?: OwnerBy)
  decideGate(store, now, taskId, gate, decision, seenDocVersion, comment, approvalId?, by?: OwnerBy)
  editTask(store, now, taskId, expectedVersion, patch, by?: OwnerBy)
  export function createTaskFromGitHub(store: BoardStore, now: () => Date,
    input: { factoryId: string; title: string; description: string; repo: RepoId; baseBranch: string; status: 'inbox' | 'ready' }, issue: string): Promise<Task>;
  ```
- `by.actor` replaces `OWNER_ACTOR` in every event the call writes. `by.reason` replaces the default reason when given.
- `createTaskFromGitHub` runs `insertTask` with actor `github` and reason `created from GitHub issue <issue>`.
- Without `by`, events are unchanged.

- [ ] **Step 1: Write the failing tests** in `owner.test.ts`:
  - `markReady with by records the github actor`: `markReady(store, now, id, { actor: 'github', reason: 'marked ready on GitHub' })` gives a `status` event with actor `github` and that reason.
  - `decideGate with by records github · login`.
  - `createTaskFromGitHub makes a ready task with a github create event`.
  - `without by the actor is still you`.
- [ ] **Step 2: Run** `npx vitest run test/owner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by threading `by` into `ownerUpdate`/`ownerFieldEvents`/`move` and the `decideGate` event.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS (`board-ui` calls stay valid; the parameter is optional).
- [ ] **Step 5: Commit** `git commit -am "Owner actions can name who acted; create a task from a GitHub issue"`

### Task 5: Restart a stage-less blocked task (GitHub-only); engine leftover

**Files:**
- Modify: `core/src/status.ts` (`CORE_PAIRS` += `['blocked','ready']`), `core/src/machine.ts`, `core/src/engine.ts` (`syncGate` `blocked` case, `linkedIssue`)
- Test: `core/test/machine.test.ts`, `core/test/status.test.ts`, `core/test/engine.test.ts`

**Interfaces:**
- Produces:
  - Machine input `{ kind: 'restart' }`. It is legal only for `blocked` with `stage === null`, and goes to `ready`, stage null, reason `restarted from ready`, patch `{ attempt: 0, question: null, blockedReason: null, answer: null }`. Anything else throws `IllegalInputError`.
  - `syncGate` `blocked` case: when `answer?.trim()`, `stage === null` and `def.github?.mode === 'github-only'`, apply `restart`. The existing `answered` branch is unchanged.
  - `linkedIssue`: the bare `catch` logs `PR body: issue link not read (<firstLine>)` through `deps.log` and returns undefined.

- [ ] **Step 1: Write the failing tests.**
  - `machine.test.ts`: `restart moves a stage-less blocked task to ready and clears the block`; `restart with a stage is illegal`.
  - `status.test.ts`: `core may move blocked to ready; you may not`.
  - `engine.test.ts`:
    - `an answered stage-less blocked task restarts in a github-only factory`.
    - `the same task stays blocked in a factory without github` (anti-goal).
    - `a failed link read is logged and the PR still opens`.
- [ ] **Step 2: Run** `npx vitest run test/machine.test.ts test/status.test.ts test/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The existing `every row result is a legal core move` test must keep passing, so add a `restart` row to its table.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Restart a stage-less blocked task from ready in GitHub-only factories"`

### Task 6: Pull planner (pure)

**Files:**
- Create: `core/src/githubPull.ts`
- Modify: `core/src/browser.ts` (export the module)
- Test: `core/test/githubPull.test.ts`

**Interfaces:**
- Consumes: `stripMarker`, `markerIn`, `issueText`, `bodyHash`, `projectKey` (Task 1); `GitHubLink`, `PushedState`; `ProjectItem`, `IssueComment` (types); `PrReview`, `PrState` (types, Task 3); `GitHubSettings`; `Task`, `Approval`, `Gate`; `sameApproval`.
- Produces:
  ```ts
  export interface IssueRef { repo: string; number: number }          // repo "owner/repo"
  export const issueName = (r: IssueRef): string => `${r.repo}#${r.number}`;
  export type PullCommand = { cmd: 'approve' | 'changes' | 'answer' | 'unblock'; text: string };
  export function parseCommand(body: string): PullCommand | null;
  export interface PullTaskView {
    task: Task; link: GitHubLink; docs: { spec?: number; plan?: number; review?: number }; approvals: Approval[];
    comments?: IssueComment[]; reviews?: { headSha: string; reviews: PrReview[] }; prState?: PrState;
  }
  export interface PullInput {
    factoryId: string; settings: GitHubSettings;
    repos: { repoId: string; slug: string; baseBranch: string }[];   // this factory's, slug "owner/repo"
    otherRepos: string[];                                           // slugs owned by other factories
    items: ProjectItem[];
    tasks: PullTaskView[];                                          // this factory's tasks that have a link
    unlinked: string[];                                             // ids of this factory's tasks without a link
  }
  export type PullAction =
    | { kind: 'create'; issue: IssueRef; nodeId: string; itemId: string; option: string | null; labelled: boolean;
        repoId: string; baseBranch: string; title: string; description: string; status: 'inbox' | 'ready' }
    | { kind: 'ready'; taskId: string; version: number; issue: IssueRef; onApplied: Partial<PushedState> }
    | { kind: 'edit'; taskId: string; version: number; issue: IssueRef; title?: string; description?: string; onApplied: Partial<PushedState> }
    | { kind: 'cancel'; taskId: string; version: number; issue: IssueRef; why: 'issue closed' | 'label removed' }
    | { kind: 'block'; taskId: string; version: number; issue: IssueRef; reason: 'label removed' }
    | { kind: 'decide'; taskId: string; version: number; issue: IssueRef; gate: Gate; decision: 'approve' | 'changes';
        docVersion: number; comment: string; approvalId: string; by: string; commentId: number | null }
    | { kind: 'answer'; taskId: string; version: number; issue: IssueRef; text: string; by: string; unblock: boolean; commentId: number };
  export interface NotApplied { taskId: string | null; issue: string; change: string; reason: string; link?: { option?: string; report?: string } }
  export interface PullPlan { factoryId: string; actions: PullAction[]; notApplied: NotApplied[] }
  export interface PullNeeds { comments: { taskId: string; since: string }[]; reviews: { taskId: string; prUrl: string }[]; prStates: { taskId: string; prUrl: string }[] }
  export function pullNeeds(i: PullInput): PullNeeds;
  export function planPull(i: PullInput): PullPlan;
  ```
- `parseCommand`: the first non-blank line must start with `/approve`, `/changes`, `/answer` or `/unblock` (any case), followed by a space, a newline or the end. `text` is everything after the command, trimmed. `/answer` with blank text returns null.
- `pullNeeds`. Comments are fetched only in `github-only` mode.
  - **comments, gate:** status `spec_review`/`plan_review` (kind = spec/plan), `link.pushed.docs[kind] === docs[kind]` and `pushed.docAt[kind]` set. `since = docAt[kind]`.
  - **comments, blocked:** status `blocked`, `task.answer` null, `pushed.blocked === blockedKey(task)` and `pushed.blockedAt` set. `since = blockedAt`.
  - **reviews:** status `pr_open` with a `prUrl`.
  - **prStates:** the task has a `prUrl`, and its item's issue is closed while `!pushed.closed`.
- `planPull`. An item matches a task when `link.repo` equals the issue's repo (case-insensitive) and the issue numbers are equal. Write `obs` for the item's Status, `map` for `settings.statusMap`, `label` for `settings.label`, and `p` for `link.pushed`. For each item:
  - **Unlinked item:**
    - Skip it when the issue is closed, or its repo is in `otherRepos`.
    - Skip it when `markerIn(body).factoryId` is another factory.
    - If the marker names this factory and the task is in `unlinked`, skip it (the pusher adopts it).
    - If the marker names this factory and the task is unknown, not applied: `issue has the marker of <id>, which is not on the board` / `run factory sync --rebuild`.
    - Otherwise, when `label === ''` or the issue has the label:
      - If the repo isn't one of `repos`, not applied: `new issue` / `repo <slug> is not one of factory <f>'s repos`.
      - Else `create`, with status `ready` when `obs === map.ready`, else `inbox`. `title = issue.title.trim()`, `description = stripMarker(body)`, `baseBranch` from the repo.
  - **Linked item whose task is `done`/`cancelled`:** skip it. Otherwise apply these rules, stopping at the first one that fires:
    1. Issue closed and `!p.closed`: skip if `prState === 'merged'`, else `cancel` with why `issue closed`.
    2. `label !== ''`, the issue lacks it and `p.label === label`: `cancel` with why `label removed` when inbox/ready; skip when blocked; else `block`.
  - Then all of these:
    3. **Status.** When `obs !== null`, `obs !== map[task.status]` and `obs !== p.option`:
       - If `obs === map.ready`, `p.option === map.inbox`, `task.status === 'inbox'` and `p.status === 'inbox'`: `ready`, with `onApplied { status: 'ready', option: obs }`.
       - If `obs === map.ready` and the task is inbox but `p.status !== 'inbox'`: not applied `Status <obs>` / `changed in tsf too`.
       - Else not applied `Status <obs>` / `the factory sets this Status; it goes back to <map[task.status]>`, with `link.option = obs`.
    4. **Title/body.** `t = issue.title.trim()`, `d = stripMarker(body)`.
       - `inSync = t === task.title && d === issueText(task.description, …)`.
       - `ghChanged = t !== p.title || bodyHash(d) !== p.bodyHash`.
       - `tsfChanged = task.title !== p.title || bodyHash(issueText(task…)) !== p.bodyHash`.
       - Do nothing unless `!inSync && ghChanged`.
       - If inbox/ready and `!tsfChanged`: `edit` with only the changed fields, and `onApplied { title: t, bodyHash: markerIn(body) ? bodyHash(d) : null }`.
       - If inbox/ready and `tsfChanged`: not applied `title/body` / `changed in tsf too`.
       - Else, with `key = 'edit:' + bodyHash(t + '\n' + d)` not in `link.reported`: not applied `title/body` / `edited after ready; not applied`, with `link.report = key`.
    5. **Commands** (from `comments`, oldest first, `createdAt > since`, author on `approvers`). At a gate, the first `approve`/`changes` gives `decide` at `docs[kind]`, with `approvalId = 'github:comment:<id>'`, `comment = text`, `by = login` and `commentId`. When blocked, the first `answer`/`unblock` gives `answer`, with `text` (for `unblock` with blank text, `unblocked by <login>`) and `unblock` set.
    6. **Reviews** (`pr_open`). Among the reviews by approvers with state `approved`/`changes_requested` and `commitId === headSha`, the latest by `submittedAt` gives `decide` on gate `pr` at `docs.review`, with `approvalId = 'github:review:<id>'`, `comment = body` and `commentId: null`. With no `docs.review`, not applied `PR review` / `no review doc to decide on`.
  - Skip a `decide` when `approvals` already has `sameApproval` for gate, docVersion, decision and comment.
  - Order: `create` actions first by repo then issue number, then the rest by task id, then for each task in rule order (edit before ready).

- [ ] **Step 1: Write the failing tests** in `test/githubPull.test.ts`. Use a settings fixture (github-only, `o/3`, label `factory`, approvers `['kazi-lakit']`, the spec 5 map), one repo `app` = `o/app` with base `dev`, and helpers `item(...)`, `view(...)`. One test per rule:
  - `parseCommand reads the first line command`: `'/approve'` → approve `''`; `'/changes  fix X\nand Y'` → changes `'fix X\nand Y'`; `'/APPROVE'` → approve; `'please /approve'` → null; `'/approved'` → null; `'/answer'` → null.
  - `new labelled issue in Todo becomes a ready task`; `… in Backlog becomes inbox`; `an issue without the label is skipped; with label '' it is created`.
  - `new issue in a repo of no factory is not applied; in another factory's repo it is ignored`.
  - `issue with the marker of a missing task asks for --rebuild`; `marker of an unlinked task is left to the pusher`.
  - `card moved Backlog to Todo marks the inbox task ready`. `onApplied.option` is `Todo`.
  - `card moved while tsf moved too is not applied`.
  - `any other Status move is not applied and resets the option`. `link.option` equals the observed option.
  - `a Status equal to the map is no change`.
  - `closed issue cancels`; `a closed issue whose PR merged is left to the engine`.
  - `label removed: inbox cancels, build blocks, blocked stays`.
  - `title edited in inbox becomes an edit`; `edited after ready is reported once`: a second plan with `link.reported` holding the key reports nothing.
  - `CRLF and trailing space are not an edit`: the body is `'D\r\n\r\n<marker>\r\n'` and the task description is `'D'`.
  - `edit whose body lost the marker clears bodyHash on apply`.
  - `/approve after the spec comment by an approver decides`; `by a non-approver, or before docAt, is ignored`; `the first command wins`; `/changes text becomes the comment`.
  - `commands are not read when the current spec is not pushed yet`: `pullNeeds` has no comment target when `p.docs.spec = 1` and `docs.spec = 2`.
  - `/answer on a blocked task answers; /unblock with no text answers "unblocked by kazi-lakit"`.
  - `PR approved on the head commit decides pr approve; a review on an old commit is ignored; changes_requested decides changes`.
  - `a decision already recorded is not planned again`.
  - `connected mode reads no comments or reviews`: `pullNeeds` is empty for them.
- [ ] **Step 2: Run** `npx vitest run test/githubPull.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `githubPull.ts` and the `browser.ts` export.
- [ ] **Step 4: Run** `npx vitest run test/githubPull.test.ts test/browser.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add core/src/githubPull.ts core/test/githubPull.test.ts && git commit -am "Plan GitHub pulls as a change set of owner actions"`

### Task 7: Change set applier (pure)

**Files:**
- Create: `core/src/githubPullApply.ts`
- Modify: `core/src/browser.ts` (export)
- Test: `core/test/githubPullApply.test.ts`

**Interfaces:**
- Consumes: `PullPlan`, `PullAction`, `NotApplied`, `issueName` (Task 6); `OwnerBy`, `githubActor`, `createTaskFromGitHub` and the owner functions (Task 4); `decide` (machine), `assertMove`, `updateHeld`, `diffEvents`, `resolveGates`/`resolveSettings`/`DEFAULT_SETTINGS`.
- Produces:
  ```ts
  export interface PullApplied { taskId: string; issue: string; change: string; commentId: number | null; onApplied?: Partial<PushedState> }
  export interface PullCreated { taskId: string; issue: string; status: 'inbox' | 'ready'; action: Extract<PullAction, { kind: 'create' }> }
  export interface PullError { taskId: string | null; issue: string | null; message: string }
  export interface ApplyResult { created: PullCreated[]; applied: PullApplied[]; notApplied: NotApplied[]; errors: PullError[] }
  export function applyPull(store: BoardStore, now: () => Date, plan: PullPlan): Promise<ApplyResult>;
  ```
- Behaviour. `notApplied` starts as `plan.notApplied`. Actions run in order.
  - **Version check.** Read the task before each action. Its version must equal `action.version`, or the version returned by the previous applied action on the same task in this plan. Otherwise the action is not applied with reason `task changed meanwhile`.
  - **Calls and `change` text:**

    | Action | Call | `change` |
    |---|---|---|
    | `create` | `createTaskFromGitHub(..., issueName)` | (goes to `created`) |
    | `ready` | `markReady`, by `{ actor: 'github', reason: 'marked ready on GitHub' }` | `inbox -> ready` |
    | `edit` | `editTask` with `title`/`description`, by `github`, reason `edited on GitHub` | `title/description edited` |
    | `cancel` | `cancelTask`, reason `cancelled on GitHub (<why>)` | `cancelled (<why>)` |
    | `block` | `decide(task, { kind: 'limit', reason }, gates)`, then `assertMove(…,'core')`, `updateHeld` with the decision plus `answer: null, claimBy: null, claimUntil: null`, and `diffEvents` with actor `github` | `blocked (label removed)` |
    | `decide` | `decideGate(…, approvalId, { actor: githubActor(by) })` | `<gate> approved by <by>` / `<gate> changes requested by <by>`; gate `pr` reads `PR` |
    | `answer` | `answerTask(…, text, version, { actor: githubActor(by) })` | `answered by <by>` / `unblocked by <by>` |

  - **Errors.** `VersionConflictError`, `StaleDocError`, `OwnerActionError`, `IllegalMoveError` and `IllegalInputError` become not applied, with the error's first line as the reason. Any other error goes to `errors`, and the run continues with the next action.

- [ ] **Step 1: Write the failing tests** in `test/githubPullApply.test.ts`. Use a MemoryStore with factory `f`, repo `app`, and plans built by hand:
  - `create makes the task with a github create event` (`created[0].status`, event actor `github`).
  - `ready, edit, cancel apply with actor github`.
  - `block moves a build task to blocked with reason label removed and clears the claim`.
  - `decide writes the approval with actor github · kazi-lakit; the same approvalId twice stores one approval`.
  - `answer then unblock text`.
  - `a stale version is not applied`.
  - `two actions on one task: edit then ready both apply`.
  - `an unexpected store error is reported and the next action still runs`.
- [ ] **Step 2: Run** `npx vitest run test/githubPullApply.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `githubPullApply.ts` and the export.
- [ ] **Step 4: Run** `npx vitest run test/githubPullApply.test.ts test/browser.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add core/src/githubPullApply.ts core/test/githubPullApply.test.ts && git commit -am "Apply a pull change set through the owner actions"`

### Task 8: Puller

**Files:**
- Create: `core/src/githubPuller.ts`
- Modify: `core/test/browser.test.ts` (`FORBIDDEN` += `githubPuller`)
- Test: `core/test/githubPuller.test.ts`

**Interfaces:**
- Consumes: `planPull`, `pullNeeds` (Task 6); `applyPull` (Task 7); `GitHub.prReviews`, `prState` (Task 3); `GitHubBoard.project`/`listItems`/`listComments`/`reactToComment`; `githubConfigProblems`; link store methods; `withLinkDefaults`, `emptyPushed`; `redactSecrets`.
- Produces:
  ```ts
  export interface PullResult extends ApplyResult { factoryId: string; skipped: 'busy' | null }
  export type PullLock = (factoryId: string) => Promise<(() => void) | null>;
  export interface PullerDeps { store: BoardStore; boardFor: GitHubBoardFor; githubFor: GitHubFor; now: () => Date; lock?: PullLock }
  export class GitHubPuller {
    constructor(deps: PullerDeps);
    /** Every github-only factory (or only `factoryIds`), by factory id. Never throws for a GitHub error. */
    pull(factoryIds?: string[]): Promise<PullResult[]>;
  }
  ```
- Per factory:
  1. Take the lock. If it is held, return `skipped: 'busy'`. Always release it in `finally`.
  2. Load the project, then `listItems`. If either fails, or the project is missing, return one `PullError` with `taskId: null` and stop this factory.
  3. Build the `PullInput`. `otherRepos` comes from the other factories' repos. Read docs (spec, plan, review current versions) and approvals only for linked tasks in `spec_review`, `plan_review`, `pr_open` or `blocked`, which are the only ones `pullNeeds` can name.
  4. Fetch the needs:
     - `listComments(ref, n, since)` for each comment target.
     - `prReviews(prUrl)` and `prState(prUrl)` through `githubFor(def.ghUser)`.
     - A failed fetch is a `PullError` for that task, and its view goes without that data.
  5. Run `planPull`, then `applyPull`.
  6. Write the link records (CAS; on `VersionConflictError` re-read once and retry; a second failure is a `PullError`):
     - Each created task gets a link `{ repo, issueNumber, issueNodeId, project: projectKey, itemId, pushed: { ...emptyPushed(), status, option, title: issue.title, bodyHash: null, label: labelled ? label : null }, reported: [] }`. `bodyHash: null` means the next push writes the marker.
     - Each applied action with `onApplied` merges it into `pushed`.
     - Each not-applied item with `link.option` sets `pushed.option`; with `link.report` it is added to `reported`.
  7. React `+1` to each applied `commentId`. A failure is a `PullError` with message `reaction failed: …`, and the change stays applied.

- [ ] **Step 1: Write the failing tests** in `test/githubPuller.test.ts`. Use a MemoryStore with a github-only factory `f` (remote `git@github.com:o/app.git`), a `FakeGitHubBoard` with project `o/3`, and a `FakeGitHub`:
  - `a labelled Todo issue becomes a ready task with a link and no marker yet`. The link has `pushed.bodyHash === null`, and a following `GitHubPusher.pushTask` writes the marker into the issue body.
  - `/approve after the pushed spec comment records the approval and reacts`. Push the spec comment with the pusher, add `/approve` as `kazi-lakit`, and pull: the approval is at v1 and `board.reactions` has the comment id.
  - `a Status move not applied is put back by the next push`.
  - `PR approve review on pr_open records the pr approval`.
  - `a closed issue with a merged PR does not cancel`.
  - `a missing project is one factory error, other factories still pull`.
  - `a held pull lock skips the factory`: the lock returns null and `skipped` is `'busy'`, with no board calls.
  - `factory without github is not pulled`.
- [ ] **Step 2: Run** `npx vitest run test/githubPuller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `githubPuller.ts` and the `FORBIDDEN` entry.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add core/src/githubPuller.ts core/test/githubPuller.test.ts && git commit -am "Pull GitHub changes into GitHub-only factories"`

### Task 9: Rebuild

**Files:**
- Modify: `core/src/boardStore.ts`, `core/src/store.ts`, `core/src/blocks/store.ts`, `core/src/wire.ts` (`LazyBlocksStore`), `core/src/githubPuller.ts`
- Test: `core/test/store.test.ts`, `core/test/blocks/store.test.ts`, `core/test/githubPuller.test.ts`

**Interfaces:**
- Produces, on `BoardStore`: `restoreTask(t: Task): Promise<Task>`. It is core only (an `owner` identity throws `ForbiddenError`). It inserts the task as given at version 1, and throws `VersionConflictError` when the id exists. BlocksStore throws `ForbiddenError('tasks are restored only on the file store')`.
- Produces, on `GitHubPuller`:
  ```ts
  export interface RebuildResult { factoryId: string; rebuilt: { taskId: string; issue: string; status: Status }[]; skipped: { issue: string; reason: string }[]; error: string | null }
  rebuild(factoryIds?: string[]): Promise<RebuildResult[]>;
  ```
- Behaviour (builder's call 6):
  - `error = 'the board already has tasks for factory <f>; --rebuild only fills an empty board'` when the store has a task or link of `f`.
  - Candidates are open items in the factory's repos with `markerIn(body)` for `f` and an id matching `^T-\d+$`. A second issue with the same id is skipped with reason `duplicate marker for <id>`.
  - Docs come from `listComments(ref, n)`. Each kind uses the comment with the highest `N` among those starting `## Spec v<N>\n\n` / `## Plan v<N>\n\n`. Its body is the text after the heading, with a trailing `\n\n---\nReply …` footer removed, and it is added with author `github · rebuilt`.
  - The task: `{ title: issue.title.trim(), description: stripMarker(body), repo, baseBranch: repo base, status, stage: null, blockedReason: status === 'blocked' ? 'rebuilt from GitHub, check status' : null, … defaults }`. It is followed by a create event with actor `github` and reason `rebuilt from GitHub issue <o/r#n>`.
  - The link: `pushed = { status, option: item.status, title: issue.title, bodyHash: bodyHash(stripMarker(body)), label: labelled ? label : null, docs: { spec: specFound ? 1 : 0, plan: … }, docAt: those comments' createdAt, blocked: null, blockedAt: null, closed: false }`.

- [ ] **Step 1: Write the failing tests.**
  - In `store.test.ts` (both stores): `restoreTask keeps the id; a second restore conflicts; createTask continues after the highest id`.
  - Blocks store: `restoreTask is forbidden`.
  - In `githubPuller.test.ts`:
    - `rebuild restores marked issues`. Issues: T-2 in `Todo`; T-3 in `In progress` with comments `## Spec v2\n\nS2` and `## Plan v1\n\nP`; T-5 in `In review`; one issue with another factory's marker. Expect T-2 `ready`. Expect T-3 `blocked` with the rebuild reason and spec doc body `S2`. Expect T-5 `blocked`. The other factory's issue is not restored.
    - `rebuild spec_review with a spec comment is restored and accepts /approve`: after rebuild, a `/approve` posted after the comment is applied by `pull`.
    - `rebuild refuses a factory that has tasks`.
    - `after rebuild a push posts the blocked comment with /unblock and nothing else`.
- [ ] **Step 2: Run** `npx vitest run test/store.test.ts test/blocks test/githubPuller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `restoreTask` in every store and the Lazy forwarder, then `rebuild`.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Rebuild GitHub-only tasks from their marked issues"`

### Task 10: CLI: pull before `next`, pull in `sync`, `--rebuild`, output; docs

**Files:**
- Modify: `core/src/cli.ts`, `plugin/skills/run/SKILL.md`, `plugin/README.md`
- Test: `core/test/cli.test.ts`

**Interfaces:**
- Consumes: `GitHubPuller`, `PullResult`, `RebuildResult` (Tasks 8, 9).
- New `CliDeps` fields:
  - `githubFor?: GitHubFor` (default `lazyGitHubFor(undefined, undefined, exec)`).
  - `pullLock?: PullLock` (default: a file lock at `<findRoot()>/.factory/pull-<factoryId>.lock`, opened with `openSync(…, 'wx')`, stale after 120 s, released with `rmSync`).
- `pullBefore(cmd, store, factories)`. It runs only with `--store file`. It never throws, and prints the item lines on stderr with the `github: ` prefix. If the pull itself throws, it prints `github: pull failed (<firstLine>)`. It is called at the top of `next`, before `engine.next`, for both claim and `--peek`.
- Line format (builder's call 7), one helper `pullLines(r: PullResult): string[]`:
  - `<taskId> created from <issue> (<status>)`
  - `<taskId> <issue>: <change>`
  - `NOT APPLIED <taskId ?? '-'> <issue>: <change> (<reason>)`
  - `PULL FAIL <taskId ?? '-'> <issue ?? '-'>: <message>`
- `factory sync`:
  - A pass is `pull(only)`, then its lines, then `pulled: created <c>, applied <a>, not applied <n>, failed <f>`, then the push pass as today.
  - A busy factory prints `github: pull of <f> skipped (another pull is running)`.
  - Without `--watch`, it exits 1 when the pull or the push failed.
  - With `--watch`, it prints item lines only, and skips NOT APPLIED lines already printed in this process (a `Set` of the full line).
- `factory sync --rebuild [--factory <id>...]`. It may not be combined with `--watch` (exit 1: `--rebuild runs once; leave out --watch`).
  - Per result, it prints `<taskId> rebuilt from <issue> (<status>)`, `skipped <issue>: <reason>`, or `FAIL rebuild <f>: <error>`.
  - It ends with `rebuilt <n>`, then runs one push pass with its lines.
  - It exits 1 on any rebuild error.
- `plugin/skills/run/SKILL.md`: one sentence saying the core also pulls GitHub changes before `factory next`, and that a `github:` stderr line is informational and needs no action from the agent (leftover 7).
- `plugin/README.md`: the `factory sync` line mentions the pull and `--rebuild`.

- [ ] **Step 1: Write the failing tests** in `cli.test.ts`. Use the stage 2 style: MemoryStore `makeEngine`, `deps.githubBoardFor = () => board`, `deps.githubFor = () => fakeGitHub`, and `deps.pullLock` as an in-memory lock.
  - `next pulls a new Todo issue and hands out its spec ticket`: stdout is the ticket line for the new task, and stderr has `github: T-1 created from o/app#1 (ready)`.
  - `next --peek pulls too`: it prints `work T-1` and exits 0.
  - `next still works when the pull fails`: the board's `project` throws `GhLoginMissingError`. The exit code and stdout are as without GitHub, and stderr has `github: pull failed (`.
  - `next pulls while the lock is free and skips when held`.
  - `sync prints pull lines and the pulled summary before the push`.
  - `sync --watch prints a NOT APPLIED line once across ticks` (`watchTicks: 2`).
  - `sync --rebuild restores and pushes`: an empty store and two marked issues give `rebuilt 2`, exit 0.
  - `sync --rebuild on a factory with tasks exits 1`.
  - `sync --rebuild --watch is refused`.
  - `next on a factory without github makes no board call`.
- [ ] **Step 2: Run** `npx vitest run test/cli.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the CLI changes and the two doc edits.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`, then `cd ../plugin && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Pull before factory next and in factory sync; add factory sync --rebuild"`

### Task 11: GitHub-only mode end to end on the file store; manual check

**Files:**
- Test: `core/test/integration.test.ts` (new `describe('GitHub-only end to end')`; tighten the stage 2 marker assertion)
- Modify: `docs/superpowers/specs/2026-11-13-github-board-integration-design.md`. Under 8.3, add one line: "Stage 3 build: pure planner and applier with a change set reusable by the Board, see the stage 3 plan's builder's calls."

**Interfaces:**
- Consumes: everything above, through `run()` with `--store file`, a temp `FACTORY_ROOT`, `factories/f/factory.yaml` (github-only, project `o/3`, map from spec 5, `protectedBranches` default) and a repo yaml with `remote: git@github.com:o/app.git` and checks that are all `true`.
- The test's `makeEngine` builds an `Engine` over a `FileStore` on the same `board.json`, with `LocalGitRepos(root)` and `PathRemoteGitHub` (already in this file). Its `factories()` returns the store's repos with `remote` replaced by the temp bare repo. The engine pushes to the bare repo, while the pusher and puller read the GitHub remote from the store. `deps.githubBoardFor` returns one `FakeGitHubBoard`, and `deps.githubFor` returns the same `PathRemoteGitHub`. Spec and PR gates are on and the plan gate is off, through `FileStore.updateSettingsScope('f', …)` before the first command.

- [ ] **Step 1: Write the test** `a hand-made issue goes from Todo to Merged through comments, reviews and the merge`:
  1. Create issue `o/app#1` in the fake with label `factory`, add it to the project, and set Status `Todo`. Run `next`: stderr has `T-1 created from o/app#1 (ready)` and the ticket is `spec`. After `next`'s push, the issue body ends with exactly `<!-- tsf:task=T-1 factory=f -->`.
  2. Run `complete T-1 spec --reply <file>`: the issue gets a comment starting `## Spec v1` with `/approve`, and Status is `In progress`.
  3. Fake comment `/approve` by `someone-else`, then `/changes add tests` by `kazi-lakit`, then `next`: the non-approver is ignored, the ticket is `spec` with feedback `add tests`, and `board.reactions` holds only the `/changes` comment. Complete spec v2. Fake comment `/approve`, then `next`: the ticket is `plan`.
  4. Drive plan, build, `check`, verify `pass`, review `approve` and `ship` as the first integration test does: the task is `pr_open`, the PR body has `Closes #1`, and Status is `In review`.
  5. `fakeGitHub.addReview(prUrl, { author: 'kazi-lakit', state: 'approved' })`, then `next`: a `pr` approval exists, and the task stays `pr_open` (base `dev` is protected).
  6. `fakeGitHub.setState(prUrl, 'merged')` and `board.closeIssue(o/app, 1, 'completed')` (as GitHub does for `Closes #1`), then `next`: the task is `done`, not `cancelled`. Then `sync`: Status is `Merged`, and the output has `pulled: created 0, applied 0, not applied 0, failed 0`.
  - In the stage 2 test, replace `toMatch(/<!-- tsf:task=[^>]*-->\s*$/)` with ``toMatch(new RegExp(`<!-- tsf:task=${id} factory=f -->$`))``.
- [ ] **Step 2: Run** `npx vitest run test/integration.test.ts`. Expected: PASS. If it fails, fix the owning task's code, not the test's expectations.
- [ ] **Step 3: Run the full suite** `npx vitest run && npm run typecheck`. Expected: all PASS.
- [ ] **Step 4: Commit** `git commit -am "Test GitHub-only mode end to end on the file store"`
- [ ] **Step 5 (owner, manual, before release):** against a throwaway Project:
  1. Create a labelled issue in `Todo` and run `factory next --factory <id>`: the task is created and the issue body gets the marker.
  2. Answer the spec with `/approve`: there is a 👍 and the next `factory next` moves on.
  3. Approve and merge the PR in GitHub: `done`, the issue is closed, and Status is in the `done` option.
  4. Move `.factory/board.json` aside and run `factory sync --rebuild`: the open issues come back as tasks.
