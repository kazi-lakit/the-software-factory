# GitHub Integration Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the shared groundwork for both GitHub modes: the `github` factory config with its validation, a GitHub Issues and Projects v2 client with a fake, a new `factory doctor` command that checks a factory's GitHub setup, and the ground-rule change with its decision record. Nothing is synced yet.

**Architecture:** A pure `githubConfig.ts` validates the new optional `github` block and plugs into `validateFactoryDef`, so YAML (file store) and the browser share one validator. A new `githubBoard.ts` holds a `GitHubBoard` interface with an Octokit implementation (REST for issues, comments and labels; GraphQL for Projects v2) and an in-memory fake. `wire.ts` gets a lazy per-login wrapper like the existing `LazyGitHub`. `factory doctor` uses these to report problems; it changes nothing on GitHub.

**Tech Stack:** TypeScript (Node ≥22, ESM), vitest, `@octokit/rest` 22 (`octokit.graphql` for Projects v2), commander, yaml.

**Spec:** `docs/superpowers/specs/2026-11-13-github-board-integration-design.md` (draft copy: `runs/design/2026-11-13-github-board-integration-design.md`). This plan covers build-order stage 1 (spec §13). Stages 2–4 get their own plans.

## Global Constraints

- A factory with no `github` block behaves exactly as today: `validateFactoryDef` output for such input is unchanged (no `github` key).
- `factories.ts` and `githubConfig.ts` stay pure (no Node API): `board-ui` imports them through `core/src/browser.ts`.
- The browser never holds a GitHub token. Only `wire.ts`/CLI code reads tokens, via `readGhToken(ghUser)`.
- Agents never touch GitHub; nothing in `plugin/` changes in this stage.
- `label` defaults to `factory`; `""` means no label filter. `approvers` defaults to `[ghUser]`.
- `mode` is `github-only` (file store only) or `connected` (Blocks store only).
- Every status in `ALL_STATUSES` must have a `statusMap` entry; the `inbox` and `ready` options differ; of the other statuses only `done` and `cancelled` may share them.
- With GitHub on, no two repo entries (in one factory or across factories) may point at the same GitHub repo (compare `parseRemote` owner/repo case-insensitively).
- Projects v2 needs the `project` scope on the factory's gh login.
- BlocksStore is not changed in this stage: Blocks persistence of `github` is stage 4. Stage 1 config is read from `factories/<id>/factory.yaml` only.
- Never push. Commit on `dev` only when told to in a step.

## Review Focus

1. A YAML file with `github:` present but empty (`github: null` or `github: {}`): `null` means no GitHub (like absent); `{}` fails with "github.mode is required". → tests in Task 2.
2. Project option names typed with different case or stray spaces (`"in progress "`): matching against the live Project is exact after trimming the config value; doctor names the option as missing rather than silently matching another. → test in Task 4 (fake) and Task 5.
3. A Project owned by an org vs a user (`SELISEdigitalplatforms/3` vs `kazi-lakit/3`): `project()` must find both, and return `null` (not throw) when neither exists. → tests in Task 4.
4. A Project with more than 100 items: `listItems` pages until done. → test in Task 4.
5. The gh login not logged in or lacking scopes: doctor reports it per factory and keeps checking the others, exit code 1; it never prints a token. → test in Task 5.

---

### Task 1: Ground rule change and decision record

**Files:**
- Modify: `docs/superpowers/specs/2026-11-09-software-factory-design.md` (§1 "Not in phase 1" list; §2 rule 3)
- Create: `docs/decisions/2026-11-13-github-board-integration.md`

- [ ] **Step 1: Edit the main spec.** Remove the line "GitHub Issues or Projects, or any other tracker besides the Board" from §1. Replace rule 3 with exactly:
  `3. **Board:** the Board is its own Blocks project in Blocks Data. It does not use ACR. GitHub Issues and Projects are used only as described in the GitHub board integration design (docs/superpowers/specs/2026-11-13-github-board-integration-design.md), and only by the core.`
- [ ] **Step 2: Write the decision record** (short: context, decision, approaches A and B with why B, consequences: local state in GitHub-only mode, one machine per GitHub-only factory, ground rule 3 changed, Board applies pulled changes as owner in connected mode). Link the design doc.
- [ ] **Step 3: Commit**
```bash
git add docs/superpowers/specs/2026-11-09-software-factory-design.md docs/decisions/2026-11-13-github-board-integration.md
git commit -m "Allow GitHub Issues and Projects through the core (ground rule 3)"
```

### Task 2: `github` config block and validation

**Files:**
- Create: `core/src/githubConfig.ts`, `core/src/validated.ts`
- Modify: `core/src/status.ts:17` (export the status list), `core/src/factories.ts` (`FactoryDef`, `validateFactoryDef`), `core/src/browser.ts` (re-export)
- Test: `core/test/githubConfig.test.ts`, `core/test/factories.test.ts`

**Interfaces:**
- Produces:
  - `export const ALL_STATUSES: readonly Status[]` in `status.ts` (rename of the private `ALL`; keep its order).
  - In `githubConfig.ts`:
    ```ts
    export type GitHubMode = 'github-only' | 'connected';
    export interface ProjectRef { owner: string; number: number }
    export interface GitHubSettings {
      mode: GitHubMode;
      project: ProjectRef;
      label: string;              // '' = no filter
      approvers: string[];        // GitHub logins, at least one
      statusMap: Record<Status, string>; // trimmed option names
    }
    export const DEFAULT_LABEL = 'factory';
    export function parseProjectRef(v: string): ProjectRef | null; // "owner/number", owner a GitHub login, number a positive integer
    export function validateGitHubSettings(input: unknown, ghUser: string): Validated<GitHubSettings | undefined>;
    ```
  - `FactoryDef` gains `github?: GitHubSettings`.

- [ ] **Step 1: Write the failing tests** in `core/test/githubConfig.test.ts`:
```ts
const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
  plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
  pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' };
const input = (over = {}) => ({ mode: 'github-only', project: 'kazi-lakit/3', statusMap: map, ...over });

test('absent or null is no GitHub', () => {
  expect(validateGitHubSettings(undefined, 'kazi-lakit')).toEqual({ ok: true, value: undefined });
  expect(validateGitHubSettings(null, 'kazi-lakit')).toEqual({ ok: true, value: undefined });
});
test('defaults label and approvers', () => {
  const r = validateGitHubSettings(input(), 'kazi-lakit');
  expect(r).toEqual({ ok: true, value: { mode: 'github-only', project: { owner: 'kazi-lakit', number: 3 }, label: 'factory', approvers: ['kazi-lakit'], statusMap: map } });
});
test('empty label is kept as no filter', () => {
  expect(validateGitHubSettings(input({ label: '' }), 'u')).toMatchObject({ ok: true, value: { label: '' } });
});
test('{} needs a mode', () => {
  expect(validateGitHubSettings({}, 'u')).toEqual({ ok: false, error: 'github.mode is required' });
});
test.each([
  [{ mode: 'mirror' }, 'github.mode must be github-only or connected'],
  [{ project: 'kazi-lakit' }, 'github.project must be owner/number'],
  [{ project: 'kazi-lakit/0' }, 'github.project must be owner/number'],
  [{ approvers: [] }, 'github.approvers must list at least one GitHub login'],
  [{ approvers: ['not a login'] }, 'github.approvers must list at least one GitHub login'],
  [{ statusMap: { ...map, testing: 'Testing' } }, 'github.statusMap has an unknown status: testing'],
  [{ statusMap: { ...map, verify: undefined } }, 'github.statusMap.verify is required'],
  [{ statusMap: { ...map, verify: '  ' } }, 'github.statusMap.verify must not be blank'],
  [{ statusMap: { ...map, ready: 'Backlog' } }, 'github.statusMap: inbox and ready must map to different options'],
  [{ statusMap: { ...map, blocked: 'Todo' } }, 'github.statusMap.blocked must not share the ready option (only done and cancelled may)'],
])('rejects %j', (over, error) => {
  expect(validateGitHubSettings(input(over), 'u')).toEqual({ ok: false, error });
});
test('done and cancelled may share inbox/ready options; names are trimmed', () => {
  const r = validateGitHubSettings(input({ statusMap: { ...map, done: 'Todo ', cancelled: 'Backlog' } }), 'u');
  expect(r).toMatchObject({ ok: true, value: { statusMap: { done: 'Todo', cancelled: 'Backlog' } } });
});
```
In `core/test/factories.test.ts` add: a def without `github` validates to an object with no `github` key; a def with the `input()` block above carries `github`; a def with a bad block fails with the same error text.

- [ ] **Step 2: Run to verify they fail**
Run: `cd core && npx vitest run test/githubConfig.test.ts test/factories.test.ts`
Expected: FAIL (module `../src/githubConfig.js` not found).

- [ ] **Step 3: Implement** `githubConfig.ts` (pure). To avoid an import cycle with `factories.ts`, move `Validated` and `GH_USER_PATTERN` into a new pure `core/src/validated.ts`; `factories.ts` re-exports both so existing imports keep working, and `githubConfig.ts` imports them from `validated.ts`. Export `ALL_STATUSES` from `status.ts`. In `validateFactoryDef`, validate `input.github` with the resolved `ghUser` and add `github` to the value only when defined. Re-export `validateGitHubSettings`, `parseProjectRef`, `DEFAULT_LABEL` and the types from `browser.ts`.

- [ ] **Step 4: Run tests and typecheck**
Run: `cd core && npx vitest run && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**
```bash
git add core/src/githubConfig.ts core/src/validated.ts core/src/status.ts core/src/factories.ts core/src/browser.ts core/test/githubConfig.test.ts core/test/factories.test.ts
git commit -m "Add the github factory config block and its validation"
```

### Task 3: Cross-factory GitHub checks (store pairing, one owner per repo)

**Files:**
- Modify: `core/src/githubConfig.ts`
- Test: `core/test/githubConfig.test.ts`

**Interfaces:**
- Consumes: `GitHubSettings`, `FactoryDef.github` (Task 2); `parseRemote` from `core/src/github.ts` (pure function; if importing `github.ts` would pull Octokit into the browser bundle, move `parseRemote` to a new pure `core/src/remote.ts` and re-export it from `github.ts`).
- Produces:
  ```ts
  export interface GitHubConfigProblem { factoryId: string; repoId?: string; message: string }
  export function githubConfigProblems(defs: FactoryDef[], repos: FactoryRepo[], store: 'file' | 'blocks'): GitHubConfigProblem[];
  ```

- [ ] **Step 1: Write the failing tests:**
  - `github-only` on `'blocks'` → `{ factoryId, message: 'github mode github-only needs the file store' }`; `connected` on `'file'` → `'github mode connected needs the Blocks store'`.
  - Two repos (same or different factories, both with `github`) whose remotes are `git@github.com:O/R.git` and `https://github.com/o/r` → one problem on the second (by factoryId then repoId order): `'O/R is already used by <factoryId>/<repoId>; a GitHub repo can belong to only one factory repo'`.
  - The same two remotes where neither factory has `github` → no problem.
  - A repo whose remote `parseRemote` rejects, in a factory with `github` → `'remote is not a GitHub repo; GitHub mode needs one'`.
  - No `github` anywhere → `[]`.
- [ ] **Step 2: Run to verify they fail** — `cd core && npx vitest run test/githubConfig.test.ts` → FAIL (`githubConfigProblems` not exported).
- [ ] **Step 3: Implement `githubConfigProblems`** in `githubConfig.ts`. Sort defs by factoryId and repos by (factoryId, repoId) so the "already used by" target is stable.
- [ ] **Step 4: Run tests and typecheck** — `cd core && npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit**
```bash
git add core/src/githubConfig.ts core/test/githubConfig.test.ts
git commit -m "Check GitHub store pairing and one factory per GitHub repo"
```

### Task 4: GitHub Issues and Projects v2 client, with a fake

**Files:**
- Create: `core/src/githubBoard.ts`
- Modify: `core/src/wire.ts` (lazy per-login wrapper)
- Test: `core/test/githubBoard.test.ts`, `core/test/wire.test.ts`

**Interfaces:**
- Consumes: `ProjectRef` (Task 2), `readGhToken`, `GhLoginMissingError`, `SecretMissingError` (`core/src/secrets.ts`).
- Produces (all in `githubBoard.ts`):
  ```ts
  export interface RepoRef { owner: string; repo: string }
  export interface ProjectInfo { projectId: string; statusFieldId: string; options: { id: string; name: string }[] }
  export interface BoardIssue {
    repo: RepoRef; number: number; nodeId: string; title: string; body: string;
    state: 'open' | 'closed'; stateReason: 'completed' | 'not_planned' | 'reopened' | null;
    labels: string[]; updatedAt: string;
  }
  export interface ProjectItem { itemId: string; status: string | null; issue: BoardIssue } // draft items and PRs are skipped
  export interface IssueComment { id: number; author: string; body: string; createdAt: string }
  export class UnknownStatusOptionError extends Error { constructor(option: string) } // message: `Project has no Status option "${option}"`
  export interface GitHubBoard {
    ensureReady?(): Promise<void>;
    tokenScopes(): Promise<string[]>;                       // from the x-oauth-scopes header of GET /user
    project(p: ProjectRef): Promise<ProjectInfo | null>;    // user or org owner; null when absent; field named "Status" (single select)
    listItems(p: ProjectInfo): Promise<ProjectItem[]>;      // all pages, 100 per page
    createIssue(r: RepoRef, i: { title: string; body: string; labels: string[] }): Promise<{ number: number; nodeId: string }>;
    updateIssue(r: RepoRef, number: number, patch: { title?: string; body?: string; labels?: string[] }): Promise<void>;
    closeIssue(r: RepoRef, number: number, reason: 'completed' | 'not_planned'): Promise<void>;
    addToProject(p: ProjectInfo, issueNodeId: string): Promise<string>;           // returns itemId; idempotent
    setStatus(p: ProjectInfo, itemId: string, option: string): Promise<void>;    // exact name; UnknownStatusOptionError when absent
    listComments(r: RepoRef, number: number, since?: string): Promise<IssueComment[]>; // oldest first, all pages
    addComment(r: RepoRef, number: number, body: string): Promise<IssueComment>;
    reactToComment(r: RepoRef, commentId: number, content: '+1'): Promise<void>;
    labelExists(r: RepoRef, name: string): Promise<boolean>;
    createLabel(r: RepoRef, name: string): Promise<void>;
  }
  export type GitHubBoardFor = (ghUser: string) => GitHubBoard;
  export class OctokitGitHubBoard implements GitHubBoard { constructor(token: string, opts?: { fetch?: typeof fetch }) }
  export class FakeGitHubBoard implements GitHubBoard {
    scopes: string[];                                                     // default ['repo', 'project']
    addProject(p: ProjectRef, options: string[]): ProjectInfo;
    issue(r: RepoRef, number: number): BoardIssue & { comments: IssueComment[]; itemStatus?: string | null };
    addComment(r: RepoRef, number: number, body: string, author?: string): Promise<IssueComment>; // author default 'kazi-lakit'
    labels: Map<string, Set<string>>;                                     // key `${owner}/${repo}` lower-cased
  }
  ```
  - In `wire.ts`: `export function lazyGitHubBoardFor(read?: (user: string) => Promise<string>, make?: (token: string) => GitHubBoard, exec?: ExecFile): GitHubBoardFor` — one client per login, token read on first call, failed read not cached, `SecretMissingError` mapped to `GhLoginMissingError(user)` exactly as `LazyGitHub` does (extract that shared load-once logic into one private helper used by both rather than copying it).

- [ ] **Step 1: Write the failing tests** in `core/test/githubBoard.test.ts`, following `core/test/github.test.ts` (Octokit with a `fetch` stub returning `Response`s):
  - `tokenScopes` parses `x-oauth-scopes: repo, project, read:org` → `['repo', 'project', 'read:org']`; missing header → `[]`.
  - `project({ owner: 'SELISEdigitalplatforms', number: 3 })` with a GraphQL stub answering `repositoryOwner: { projectV2: { id: 'P1', field: { id: 'F1', options: [{ id: 'o1', name: 'Todo' }] } } }` → `{ projectId: 'P1', statusFieldId: 'F1', options: [{ id: 'o1', name: 'Todo' }] }`; `repositoryOwner: null` → `null`; `projectV2: null` → `null`.
  - `listItems` with two pages (`pageInfo.hasNextPage: true, endCursor: 'c1'` then `false`) returns items from both and sends `after: "c1"` on the second request; a `DraftIssue` node and a `PullRequest` node are skipped.
  - `setStatus` with an option name not in `ProjectInfo.options` rejects with `UnknownStatusOptionError` before any network call; with a known name it sends `updateProjectV2ItemFieldValue` with `singleSelectOptionId: 'o1'`.
  - `closeIssue(r, 5, 'not_planned')` sends `PATCH /repos/o/r/issues/5` with `{ state: 'closed', state_reason: 'not_planned' }`.
  - `FakeGitHubBoard`: `createIssue` then `addToProject` then `setStatus(…, 'Todo')` → `listItems` returns the item with `status: 'Todo'` and the issue's labels; `addToProject` twice returns the same itemId; `setStatus(…, 'todo')` (wrong case) rejects with `UnknownStatusOptionError`; `listComments(r, n, since)` returns only comments with `createdAt > since`.
  In `core/test/wire.test.ts`: `lazyGitHubBoardFor` reads the token once per login, and a failing read (`SecretMissingError`) rejects with `GhLoginMissingError` and is retried on the next call.
- [ ] **Step 2: Run to verify they fail** — `cd core && npx vitest run test/githubBoard.test.ts test/wire.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `githubBoard.ts` and `lazyGitHubBoardFor`.** REST via `octokit.rest.issues.*`/`reactions.createForIssueComment`/`users.getAuthenticated` (read `headers['x-oauth-scopes']`); GraphQL via `octokit.graphql`. `project()` queries `repositoryOwner(login:) { ... on User { projectV2(number:) {…} } ... on Organization { projectV2(number:) {…} } }` with `field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }`; a GraphQL `NOT_FOUND` error for the project resolves to `null`. `listItems` reads `content { ... on Issue { … labels(first: 50) { nodes { name } } repository { owner { login } name } } }` and `fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`.
- [ ] **Step 4: Run tests and typecheck** — `cd core && npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit**
```bash
git add core/src/githubBoard.ts core/src/wire.ts core/test/githubBoard.test.ts core/test/wire.test.ts
git commit -m "Add the GitHub Issues and Projects client with a fake"
```

### Task 5: `factory doctor`

**Files:**
- Create: `core/src/doctor.ts`
- Modify: `core/src/cli.ts` (`CliDeps`, new command)
- Test: `core/test/doctor.test.ts`, `core/test/cli.test.ts`

**Interfaces:**
- Consumes: `githubConfigProblems` (Task 3), `GitHubBoardFor`, `UnknownStatusOptionError`, `lazyGitHubBoardFor` (Task 4), `parseRemote`, `ghLoggedInUsers`, `isGhLoggedIn` (`secrets.ts`).
- Produces:
  ```ts
  export interface DoctorCheck { factoryId: string; check: string; ok: boolean; detail: string }
  export async function doctor(o: {
    defs: FactoryDef[]; repos: FactoryRepo[]; store: 'file' | 'blocks';
    loggedIn: ReadonlySet<string>; boardFor: GitHubBoardFor;
  }): Promise<DoctorCheck[]>;
  ```
  - `CliDeps` gains `githubBoardFor?: GitHubBoardFor` (default `lazyGitHubBoardFor(undefined, undefined, exec)`).
  - CLI: `factory doctor [--factory <id>…] [--json]`; prints one line per check `ok|FAIL <factoryId> <check>: <detail>`; exit 1 when any check fails.

- [ ] **Step 1: Write the failing tests** in `core/test/doctor.test.ts` with `FakeGitHubBoard`. Check names and order per factory: `gh login`, then (only with `github`) `config`, `scope`, `project`, `status options`, then one `label <repoId>` per repo.
  - Factory without `github`, logged in → exactly `[{ check: 'gh login', ok: true, detail: 'kazi-lakit logged in' }]`.
  - Not logged in → `gh login` fails with `'kazi-lakit is not logged in (run: gh auth login --hostname github.com)'` and no further checks for that factory; a second factory is still checked.
  - Scopes `['repo']` → `scope` fails `'the gh login needs the project scope (run: gh auth refresh -s project)'`, and `project`/`status options` are skipped (not listed).
  - Project missing → `project` fails `'project kazi-lakit/3 not found or not visible to kazi-lakit'`.
  - Project options `['Backlog', 'Todo', 'In progress', 'In review']` with the Task 2 map → `status options` fails `'missing on the Project: Merged'`; with `'Merged'` added → ok `'all 13 statuses map to existing options'`. An option `'in progress'` in the Project with `'In progress'` in the map → fails naming `In progress` (exact match).
  - Label missing in repo → `label <repoId>` ok with detail `'missing; created on first push'`; label `''` → ok `'no label filter'`.
  - `githubConfigProblems` output appears as failing `config` checks (one per problem, detail = message); with none, one ok `config` check `'ok'`.
  - No token or token-shaped string appears in any `detail` (assert none contains `'gho_'` with a fake that would expose one).
  In `core/test/cli.test.ts`: `factory doctor` on a seeded file store prints the lines and exits 1 on a failing check, 0 when all pass; `--json` prints `{ checks: DoctorCheck[] }`.
- [ ] **Step 2: Run to verify they fail** — `cd core && npx vitest run test/doctor.test.ts test/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement `doctor()`** in `core/src/doctor.ts` and the `doctor` command in `cli.ts` (reads defs/repos from `store`, logins from `ghLoggedInUsers(exec)`, store kind from `--store`). A thrown client error inside one factory's checks becomes a failing check with the first line of its message, and the next factory is still checked.
- [ ] **Step 4: Run tests and typecheck** — `cd core && npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Manual check (owner, real GitHub).** With a throwaway Project and `factories/<id>/factory.yaml` carrying a `github` block, run `factory doctor --factory <id>` and confirm each line matches reality. Record the result in the PR description.
- [ ] **Step 6: Commit**
```bash
git add core/src/doctor.ts core/src/cli.ts core/test/doctor.test.ts core/test/cli.test.ts
git commit -m "Add factory doctor with GitHub setup checks"
```
