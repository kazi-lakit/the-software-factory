# Multiple Factories Implementation Plan (plan 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One factory application runs several factories (`blocks`, `delta`, `mods`, `tsf`, …). Each factory has its own Board view, repos, settings, GitHub login (gh), protected branches, git identity and docs folder. Factories and repos are defined on the Board.

**Architecture:**
- A `FactoryConfig` model replaces the fixed `REPO_IDS` list and the `repos/*.yaml` loader.
- The Blocks store has three new tables: `FactoryDef` and `FactoryRepo` (owner-only writes) and `FactoryHealth` (written by the core). Tasks and events carry `factoryId`, and settings become per factory.
- The engine claims across factories with an optional filter. It applies each factory's protected branches, git identity, gh login and clone folder.
- The Board page gets a factory picker, a Waiting-for-you strip, and a Factories settings tab.
- A one-time `factory migrate` moves today's work into factory `blocks`.

**Tech Stack:** TypeScript core and `factory` CLI (commander, zod, yaml, vitest); Blocks Data via `@seliseblocks/client`; React/Vite Board page (vitest); the Claude Code plugin (Node ESM hooks, skills).

**Spec:** `docs/superpowers/specs/2026-11-10-multi-factory-design.md` (approved 2026-11-10). The base spec is `docs/superpowers/specs/2026-11-09-software-factory-design.md`.

**Branch:** `feat/multi-factory`, cut from `main` after plan 4 (`feat/plugin`) is merged.

**Not in this plan:** the SDK runner's `factory run --factory <id>…` belongs to plan 5. It reuses `Engine.next(taskId, filter)` from Task 4.

## Global Constraints

- `factoryId` and `repoId` match `^[a-z][a-z0-9-]*$` and are at most 40 characters. A `repoId` is unique within its factory, and the same `repoId` may exist in two factories.
- `main` is always protected. Validation adds it if it's missing, and no edit can remove it. The factory never pushes to a protected branch and never uses `main` as a task base.
- A factory opens PRs with the token of a gh CLI login, the factory's `ghUser` (a GitHub login; empty means `kazi-lakit`), read with `gh auth token --hostname github.com --user <ghUser>`. The Board stores the login, never a token (R16).
- Only the signed-in owner inserts or edits `FactoryDef` and `FactoryRepo`. The core reads them. The core inserts and edits `FactoryHealth`, and the owner reads it.
- Every definition change writes a `FactoryEvent` with actor `you`, field `def.<field>` or `repo.<repoId>.<field>`, and old → new values (`checks` as canonical JSON).
- Task ids are one sequence across all factories, as today.
- Settings scopes are `<factoryId>` and `<factoryId>/<repoId>`. Resolution order: task overrides, then repo, then factory, then defaults.
- Clones live at `<root>/.clones/<factoryId>/<repoId>`. Worktrees stay at `<root>/.clones/worktrees/<taskId>`.
- `factory migrate` defaults for factory `blocks`:
  - name `Blocks`;
  - protected branches `dev`, `stg`, `main`;
  - `docsPath` = `<home>/scratchpad/selise/vaultS/projects`;
  - `ghUser` `kazi-lakit`;
  - repos from `repos/*.yaml`.
- File store (tests, smoke): definitions are read from `<root>/factories/<factoryId>/factory.yaml` and `<root>/factories/<factoryId>/repos/<repoId>.yaml`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The same `repoId` in two factories** (e.g. `api` in `delta` and `mods`). Clones, settings scopes, the repo filter and new-task validation never mix them up. Tests: Task 4 (clone path, settings), Task 7 (New task repo list).
2. **The owner edits a factory while tasks are in flight.** If the edit drops `main` from the protected branches, `main` comes back and History records the attempt as saved without removing `main`. A changed check command applies from the next `check`. A repo the task needs is missing, so the task blocks. Tests: Task 1 (validation), Task 4 (missing repo blocks).
3. **One factory's gh login is not logged in.** Only that factory's `ship` blocks, with `gh account <ghUser> is not logged in (run: gh auth login)`; another factory's ship in the same run works. Test: Task 5.
4. **`factory migrate` is re-run, or fails halfway.** A re-run changes nothing, and a resumed run completes. `repos/` is never read once `blocks` exists on the Board. Test: Task 6.
5. **A filter names a paused or inactive factory, or one at its `maxParallel`.** `next --factory x` prints `paused` / `inactive` / `nothing to do` accurately, and other factories' slots don't count against x. Test: Task 4.

---

### Task 1: Factory config model and validation (core)

**Files:**
- Create: `core/src/factories.ts`, `core/test/factories.test.ts`
- Modify:
  - `core/src/types.ts`: remove `REPO_IDS`; `RepoId` becomes `string`; add `FactoryId = string`;
  - `core/src/repoConfig.ts`: keep the `checks` zod schema, export it as `ChecksSchema`; remove `loadAllRepoConfigs` and the `repo` enum;
  - `core/src/branches.ts`;
  - `core/src/browser.ts`: export the new types and `validateFactoryDef`, `validateFactoryRepo`, `ensureMain`.

**Interfaces:**
- Produces, in `factories.ts`:
  - `interface FactoryDef { factoryId: string; name: string; protectedBranches: string[]; gitName: string; gitEmail: string; docsPath: string; ghUser: string; active: boolean; version: number }`
  - `interface FactoryRepo { factoryId: string; repoId: string; remote: string; baseBranch: string; checks: Checks; version: number }` (`Checks` = `z.infer<typeof ChecksSchema>`)
  - `interface FactoryHealth { factoryId: string; ghLoggedIn: boolean; checkedAt: string }`
  - `class FactoryConfig`, built from `(defs: FactoryDef[], repos: FactoryRepo[])`, with:
    - `factories(): FactoryDef[]`
    - `factory(id): FactoryDef | undefined`
    - `repo(factoryId, repoId): FactoryRepo | undefined`
    - `repos(factoryId): FactoryRepo[]`
    - `skipped(): { id: string; reason: string }[]`
  - `validateFactoryDef(input): { ok: true; value: FactoryDef } | { ok: false; error: string }`
  - `validateFactoryRepo(input, def): { ok: true; value: FactoryRepo } | { ok: false; error: string }`
  - `ensureMain(branches: string[]): string[]` (adds `main`, dedupes, trims)
  - `loadFactoriesFromDir(dir: string): { defs: FactoryDef[]; repos: FactoryRepo[] }` (the file-store layout from Global Constraints)
- Produces, in `branches.ts`:
  - `isProtected(ref: string, protectedBranches: readonly string[] = ['dev','stg','main']): boolean` (same ref-prefix stripping; `main` always counts);
  - `assertPushAllowed(branch, protectedBranches)`.
  - `PROTECTED_BRANCHES` stays as the default for callers that have no factory.

- [ ] **Step 1: Write the failing tests** in `factories.test.ts`:
  - `ensureMain(['dev'])` returns `['dev','main']`, and `ensureMain(['main','main',' dev '])` returns `['main','dev']`;
  - `validateFactoryDef`:
    - rejects ids `Delta`, `1x`, an id of 41 characters, and `a_b`;
    - accepts `delta`;
    - forces `main` into `protectedBranches`;
    - defaults an empty `ghUser` to `kazi-lakit` and refuses one that is not a GitHub login (`ghUser must be a GitHub login`);
    - rejects a `gitEmail` without `@` when it's non-empty;
  - `validateFactoryRepo`:
    - rejects `baseBranch: 'main'` (`main is never a base`);
    - rejects a bad `repoId`;
    - rejects malformed `checks` (with the zod message);
    - accepts base `dev`;
  - `FactoryConfig` holds two factories that both have repo `api`, and `repo('delta','api').remote !== repo('mods','api').remote`;
  - `FactoryConfig` with an invalid def lists it in `skipped()` and leaves it out of `factories()`;
  - `isProtected('origin/main', ['dev'])` is true, `isProtected('rel', ['rel'])` is true, and `isProtected('feature', ['dev'])` is false;
  - `loadFactoriesFromDir` reads a temp `factories/` tree with two factories.
- [ ] **Step 2: Run** `cd core && npx vitest run test/factories.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the interfaces above. Then fix every compile error from removing `REPO_IDS` and the `RepoConfig` loader by threading `string` repo ids. Engine wiring comes in Task 4, so a temporary adapter in `wire.ts` may build a single-factory `FactoryConfig` from `repos/*.yaml` until then, factory id `blocks`.
- [ ] **Step 4: Run** `cd core && npm test && npm run typecheck`. Expected: PASS, with existing tests adjusted only where they named `REPO_IDS`.
- [ ] **Step 5: Commit** with `feat(core): factory config model and validation`.

### Task 2: Store interface and memory/file stores per factory

**Files:**
- Modify: `core/src/boardStore.ts`, `core/src/store.ts`, `core/src/owner.ts`, `core/src/types.ts` (Task, FactoryEvent), `core/test/storeContract.ts`, `core/test/owner.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces on `BoardStore`:
  - `Task.factoryId: string`
  - `NewTask.factoryId: string`
  - `FactoryEvent.factoryId: string` (`''` when it belongs to no factory)
  - `listFactoryDefs(): Promise<FactoryDef[]>`
  - `listFactoryRepos(factoryId?: string): Promise<FactoryRepo[]>`
  - `saveFactoryDef(before: FactoryDef | null, after: FactoryDef): Promise<FactoryDef>` (owner-only, compare-and-set on `version`; `before` null = insert)
  - `saveFactoryRepo(before: FactoryRepo | null, after: FactoryRepo): Promise<FactoryRepo>` (owner-only, compare-and-set)
  - `listFactoryHealth(): Promise<FactoryHealth[]>`
  - `setFactoryHealth(h: FactoryHealth): Promise<void>` (core-only)
  - `StoredSettings` becomes `{ factories: Record<string, { factory: Settings; repos: Record<string, RepoSettings> }> }`
  - `updateSettingsScope(scope: string /* '<f>' | '<f>/<r>' */, before, after)`
- Produces in `owner.ts`:
  - `saveFactory(store, now, before, after)` and `saveRepo(store, now, before, after)`. Both validate (Task 1) and then write one event per changed field (actor `you`, field per Global Constraints).
  - `createTask` and `createTaskAsCore` take `factoryId`. The repo must exist in that factory: refuse with `repo <r> is not in factory <f>`.

- [ ] **Step 1: Write the failing contract tests** (run on Memory and File):
  - an owner saves a def and lists it back, and a second save with a stale `before` gets `VersionConflictError`;
  - a core identity's `saveFactoryDef` gets `OwnerOnlyError`;
  - `setFactoryHealth` by the core is listed, and by the owner gets `OwnerOnlyError`;
  - a task in `delta` and a task in `mods` with repo `api` are both listed with the right `factoryId`;
  - `updateSettingsScope('delta/api', …)` changes only that scope;
  - `getSettings()` on an empty store gives `{ factories: {} }`.

  Owner tests:
  - `saveFactory` that removes `main` stores it with `main` and writes an event for each changed field;
  - `saveRepo` changing `checks` writes one `repo.api.checks` event with canonical old and new JSON;
  - `createTask` with repo `api` in factory `blocks` (where `api` doesn't exist) is refused.
- [ ] **Step 2: Run** `cd core && npx vitest run test/store.test.ts test/owner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - MemoryStore and FileStore keep definitions in their state.
  - FileStore seeds definitions from `loadFactoriesFromDir(<root>/factories)` the first time its state has no defs.
  - Settings migrate in the file format: an old `{global, repos}` file loads as factory `blocks`.
- [ ] **Step 4: Run** `cd core && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(core): factory-aware store interface, memory and file stores`.

### Task 3: Blocks schema, rules, BlocksStore and live gate

**Files:**
- Modify: `core/src/blocks/schema.ts`, `core/src/blocks/store.ts`, `core/tools/blocks-resources.ts` (if a new table needs it), `blocks/data/**` (regenerated), `core/tools/gate-blocks.ts`, `core/test/blocks/*.test.ts`

**Interfaces:**
- Consumes: the Task 2 `BoardStore` methods.
- Produces:
  - tables `FactoryDef` (unique index `factoryId`), `FactoryRepo` (unique index `repoKey` = `<factoryId>/<repoId>`) and `FactoryHealth` (unique index `factoryId`);
  - field `factoryId` on `FactoryTask` and `FactoryEvent`;
  - access matrix:
    - `FactoryDef` and `FactoryRepo`: read both, insert and edit owner;
    - `FactoryHealth`: read both, insert and edit core;
  - `FactoryTask` column EDIT rule fields gain `factoryId`;
  - `FactorySettings` scope values `<f>` and `<f>/<r>`.
- Field types: lists and `checks` stored as JSON strings, like `gateOverrides` today.

- [ ] **Step 1: Write the failing tests:**
  - schema test: the policy matrix rows for the three tables and the CLS EDIT field list including `factoryId`;
  - `npm run -s blocks:resources -- --check` passes after regeneration;
  - BlocksStore over `FakeBlocksData`: the Task 2 contract suite runs green;
  - `gate-blocks.test.ts` over the fake: the new steps.
- [ ] **Step 2: Run** `cd core && npx vitest run test/blocks`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, the store mapping (JSON encode and decode, `''` for null as today) and the regenerated resources. Add gate steps:
  - **12:** the core's insert and edit of `FactoryDef` and `FactoryRepo` are forbidden, and the owner's are applied;
  - **13:** the core's insert and edit of `FactoryHealth` are applied, and the owner's are forbidden;
  - **14:** the core's change of a task's `factoryId` to a different value is forbidden (the value must change, because Blocks checks only changed columns).

  Gate rows use ids prefixed `GATE-`.
- [ ] **Step 4: Run** `cd core && npm test && npm run typecheck`. Expected: PASS. Don't deploy (Task 11 does).
- [ ] **Step 5: Commit** with `feat(blocks): factory tables, factoryId columns, rules and gate steps`.

### Task 4: Engine — claiming, settings, repos and clones per factory

**Files:**
- Modify: `core/src/engine.ts`, `core/src/gates.ts`, `core/src/git.ts`, `core/src/wire.ts`, `core/test/engine.test.ts`, `core/test/git.test.ts`

**Interfaces:**
- Consumes: `FactoryConfig` (Task 1); the store methods (Task 2).
- Produces:
  - `EngineDeps.repos` is replaced by `factories: () => Promise<FactoryConfig>`, loaded from the store on each `next`, `sync` and `status`;
  - `Engine.next(taskId?: string, filter?: string[])`;
  - `Engine.status(filter?: string[])` returns `EngineStatus` plus `factories: { factoryId: string; name: string; active: boolean; paused: boolean; counts: Partial<Record<Status, number>>; ghUser: string; ghLoggedIn: boolean | null }[]`;
  - `settingsFor(stored, task)` resolves factory → repo → task;
  - `resolveSettings(factory: Settings, repo?: RepoSettings)` (rename of `global`);
  - `Ticket.context` gains `factory: { factoryId: string; name: string; docsPath: string }` and `checks: Checks` (that repo's commands), so the plugin no longer reads yaml;
  - `GitRepos.ensureClone(factoryId: string, repo: FactoryRepo, protectedBranches: string[])` with clone path `.clones/<factoryId>/<repoId>`;
  - `GitRepos.worktree(factoryId, repo, taskId, branch)`.
- Blocking reasons, verbatim:
  - `repo <r> no longer exists in <f>`;
  - `factory <f> no longer exists`.
- `next` messages, returned through a new `NextOutcome` type: `{ kind: 'ticket'; ticket } | { kind: 'none'; reason: 'nothing to do' | 'paused' | 'inactive' }`. `paused` or `inactive` is reported only when every factory in the filter is paused or inactive. The CLI prints `paused` / `inactive` / `nothing to do`.

- [ ] **Step 1: Write the failing engine tests**, with fakes and two factories `a` and `b`:
  - `next()` picks the oldest workable task across both factories;
  - `next(undefined, ['b'])` picks only in `b`;
  - `a` at `maxParallel` 1 with one active task: `next()` still picks a `b` task;
  - a paused `b` with filter `['b']` returns reason `paused`, and an inactive `b` returns `inactive`;
  - a task in `b` whose repo is gone gets blocked by `sync` with `repo api no longer exists in b`;
  - a gate resolved from `b/api` repo settings overrides `b`;
  - the ticket context carries `b`'s `docsPath` and `api` checks.

  Git tests: `ensureClone('a', api)` and `ensureClone('b', api)` give two different paths under `.clones/a/api` and `.clones/b/api`.
- [ ] **Step 2: Run** `cd core && npx vitest run test/engine.test.ts test/git.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the Task 1 adapter: `wire.ts` builds the `factories` loader from the store. `findRoot` no longer requires `repos/`. A root is a folder with `core/` and `plugin/`, and a `repos/` folder is only read by `migrate`.
- [ ] **Step 4: Run** `cd core && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(core): engine claims and resolves per factory`.

### Task 5: Ship — protected branches, git identity, gh login and hook per factory

**Files:**
- Modify: `core/src/engine.ts` (ship, openPr), `core/src/github.ts`, `core/src/wire.ts` (LazyGitHub per gh login), `core/src/secrets.ts`, `core/src/git.ts`, `core/hooks/pre-push`, `core/test/*`

**Interfaces:**
- Produces:
  - `readGhToken(user: string, exec?)` (`gh auth token --hostname github.com --user <user>`). `readSecret` stays for the `blocks-credential` account only.
  - `GitHubFor = (ghUser: string) => GitHub`, lazy and cached per login; a failed read is not cached.
  - `ship` uses the task's factory's `protectedBranches` for `assertPushAllowed` and `shouldMerge(base, prGateOn, protectedBranches)`.
  - When the factory's gh login is not logged in (`GhLoginMissingError`), `ship` blocks the task with `gh account <ghUser> is not logged in (run: gh auth login)`.
  - Git identity: when the factory sets `gitName` or `gitEmail`, `worktree()` runs `git -C <clone> config extensions.worktreeConfig true` once, then `git -C <wt> config --worktree user.name|user.email <value>`. The owner's global config is never touched.
  - Pre-push hook: `ensureClone` writes `<clone>/.git/factory-protected-branches` (one branch per line). The hook reads it from `$(git rev-parse --git-common-dir)` and always adds `main`. If the file is missing, it falls back to `dev stg main`.
- Tests:
  - **gh login:** factory `a`'s gh login is not logged in and `b`'s is. Shipping an `a` task blocks with the exact reason, and shipping a `b` task opens a PR with `b`'s client (fake GitHub records the login).
  - **Protected branches:** with `['rel','main']`, a push to `rel` is refused, while `dev` isn't protected there, so `shouldMerge('dev', false, …)` is true.
  - **Git identity:** the worktree's identity is set to `a`'s values (read back with `git config --worktree user.email`), and the global config is unchanged (compare with `git config --global` before and after in a temp `HOME`).
  - **Hook:** with `factory-protected-branches` = `rel`, the hook refuses `refs/heads/rel` and `refs/heads/main` and allows `refs/heads/dev`. With the file missing, it refuses `dev`.

- [ ] **Step 1:** Write those tests.
- [ ] **Step 2:** Run `cd core && npx vitest run test/engine.test.ts test/git.test.ts test/branchGuard.test.ts test/github.test.ts` (the existing test file names). Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd core && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(core): ship per factory — protected branches, identity, gh login, hook`.

### Task 6: CLI — filters, factories listing, status health, migrate

**Files:**
- Create: `core/src/migrate.ts`, `core/test/migrate.test.ts`
- Modify: `core/src/cli.ts`, `core/test/cli.test.ts`

**Interfaces:**
- Produces, CLI:
  - `next [task] [--factory <id>…] [--json]`, printing `paused` / `inactive` / `nothing to do` per Task 4;
  - `status [--factory <id>…] [--json]`, with per-factory lines `factory <id>: active|inactive, paused <bool>, gh <ghUser> logged in|not logged in|unknown`. `status` runs `gh auth status --hostname github.com --json hosts` once (never `gh auth token`) and calls `setFactoryHealth` for each factory with `ghLoggedIn`: true when github.com lists its `ghUser` (any case) in state `success`; a gh failure or unreadable answer is false for every factory. A write failure is logged and doesn't fail `status`.
  - `factories [--json]`, listing defs and repos (no secrets). Used by `/factory:new`.
  - `new … --factory <id>`, required unless exactly one factory is active.
  - `migrate [--dry-run] [--yes] [--check] [--export <file>]`. On the Blocks store `--yes` has no core step: it prints `nothing for the core to do on the Blocks store; import on the Board, then run factory migrate --check` and exits 0.
- Produces, `migrate.ts`: `migrate(store, root, home, exec, opts): Promise<MigrateReport>`, with `MigrateReport = { steps: { name: string; done: 'already' | 'now' | 'skipped'; detail: string }[] }`. Steps in order:
  1. Create `blocks` and its repos from `<root>/repos/*.yaml`, with the defaults from Global Constraints. Skipped if `blocks` exists.
  2. Tag every task and event with an empty `factoryId` as `blocks`.
  3. Move the stored `global` and per-repo settings to the `blocks` scopes (FileStore and BlocksStore read the old shape).
  4. `gh-login`, read-only: the same gh check as `status` for `blocks`'s `ghUser`. `already` with `gh account kazi-lakit is logged in`, else `pending` with `gh account kazi-lakit is not logged in: run gh auth login`.
  5. Read everything back and compare it with the source.
  6. Print `repos/ is no longer read; remove it with: git rm -r repos` and don't delete anything itself.

  `--dry-run` prints the steps it would take.
- Tests:
  - on Memory and File stores:
    - a fresh migrate runs every step `now`;
    - a second run is all `already`;
    - a failure injected at step 3, then a re-run, completes;
  - `next --factory delta` prints `paused` for a paused `delta`;
  - `factories --json` has no token field;
  - `new` without `--factory`, with two active factories, exits 1 with `--factory is required (active: blocks, delta)`;
  - `status` writes health rows (fake exec for `gh`: the exact `gh auth status` args, no `gh auth token`, and a gh failure gives `false`).

- [ ] **Step 1:** Write the tests.
- [ ] **Step 2:** Run `cd core && npx vitest run test/migrate.test.ts test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd core && npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(core): factory filters, factories listing, health, migrate`.

### Task 7: Board page — picker, Waiting-for-you strip, cards, New task, task page

**Files:**
- Modify: `board-ui/src/features/board/*`, `board-ui/src/features/task/TaskActions.tsx`, `board-ui/src/features/task/TaskView.tsx`, `board-ui/src/app/AppShell.tsx`, `board-ui/src/test/fakeBoard.tsx`
- Create: `board-ui/src/features/factories/useFactories.ts`, `board-ui/src/features/board/FactoryPicker.tsx`, `board-ui/src/features/board/WaitingStrip.tsx`

**Interfaces:**
- Consumes: `boardStore.listFactoryDefs()`, `listFactoryRepos()`, the task `factoryId`, and `NEEDS_YOU` (`status.ts`).
- Produces:
  - `useFactories(): { defs; repos; byId; loading; error }`, a react-query hook refreshed every 60 s;
  - `useSelectedFactory(): [string | 'all', (v) => void]`, stored in `localStorage` key `factory-board:factory` (try/catch; default `'all'`).
- Behaviour:
  - **Picker:** sits next to the repo filter. The repo filter lists the selected factory's repos, or every `factory/repo` pair when All is selected.
  - **Cards:** show `<factoryId> · T-n` when All is selected.
  - **Waiting-for-you strip:** above the columns, it lists tasks whose status is in `NEEDS_YOU` for the selected factory or all factories, oldest first. Each entry shows id, title, status label and a link. When the list is empty, the strip isn't rendered.
  - **New task:**
    - factory select first, repo select second (only that factory's repos);
    - the base defaults to the repo's `baseBranch`;
    - `main` is refused inline;
    - the factory comes from the picker when it's not All;
    - the `/factory:new` link parameters gain `factory`.
  - **TaskActions edit:** the repo list is that task's factory's repos.
  - **Task page:** the factory name sits next to the repo.
- Tests (vitest):
  - the picker persists and restores;
  - All shows factory tags;
  - the strip lists a blocked task from factory `b` with a working link, and is hidden when nothing needs you;
  - New task lists only `delta`'s repos once `delta` is chosen, and creates with `factoryId: 'delta'`;
  - a link with `factory=delta&repo=api` pre-fills both;
  - an `api` repo in two factories keeps the right factory on create.

- [ ] **Step 1:** Write the tests.
- [ ] **Step 2:** Run `cd board-ui && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `board.css` token use and accessibility patterns: the strip is a `nav` with `aria-label="Waiting for you"`.
- [ ] **Step 4:** Run `cd board-ui && npx vitest run && npx tsc --noEmit && npx vite build`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(board-ui): factory picker, waiting strip, factory-aware new task`.

### Task 8: Board page — Settings tabs (factory settings, Factories) and History filter

**Files:**
- Modify: `board-ui/src/features/settings/SettingsView.tsx`, `board-ui/src/features/history/*`
- Create: `board-ui/src/features/settings/FactoriesTab.tsx`, `board-ui/src/features/settings/FactoryForm.tsx`, `board-ui/src/features/settings/RepoForm.tsx`

**Interfaces:**
- Consumes: `saveFactory` and `saveRepo` (owner actions, Task 2); `validateFactoryDef`, `validateFactoryRepo` and `ensureMain` (browser entry, Task 1); `listFactoryHealth`.
- Behaviour:
  - **Settings, Factory settings tab:** today's view, scoped to the selected factory and its repos. It uses `updateSettingsScope('<f>')` and `('<f>/<r>')`. With All selected, it asks you to pick a factory.
  - **Settings, Factories tab:**
    - a list of factories showing name, id, active, protected branches, and the GitHub login (`ghUser`) with `logged in` / `not logged in` / `unknown` and `checkedAt` (from `FactoryHealth`; `unknown` when there's no row);
    - add and edit a factory: validated with `validateFactoryDef`, `main` shown as always on and not removable, the id read-only after creation;
    - add and edit repos per factory, with `repoId` read-only after creation;
    - a `checks` change shows the old and new JSON side by side and needs an explicit **Confirm change** before saving;
    - conflicts use the existing "changed, reload" path;
    - drafts stay in component state only, as settings drafts do today.
  - **History:** a factory select filters events by `factoryId`. Definition events show their field, old and new values.
- Tests:
  - creating `delta` with protected branches `rel` saves `['rel','main']`;
  - the `main` chip can't be removed;
  - editing `api` checks without confirming saves nothing, and confirming saves and shows a History event;
  - an invalid id shows the validation message and saves nothing;
  - the gh status renders `not logged in` from a health row;
  - Factory settings for `delta/api` update only that scope;
  - the History filter for `delta` hides `blocks` events.

- [ ] **Step 1:** Write the tests.
- [ ] **Step 2:** Run `cd board-ui && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd board-ui && npx vitest run && npx tsc --noEmit && npx vite build`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(board-ui): factories settings, per-factory settings, history filter`.

### Task 9: Plugin — factory arguments for run and new

**Files:**
- Modify: `plugin/skills/run/SKILL.md`, `plugin/skills/new/SKILL.md`, `plugin/skills/new/link.mjs`, `plugin/skills/spec/SKILL.md`, `plugin/skills/build/SKILL.md`, `plugin/README.md`, `plugin/test/*.test.mjs`

**Interfaces:**
- Consumes:
  - CLI `next [task] [--factory <id>] --json`, whose ticket has `context.factory` and `context.checks` (Task 4);
  - `factories --json`;
  - `new --factory` (Task 6).
- Behaviour:
  - **`/factory:run [<factory>|T-n] [--loop]`:**
    - a `T-` argument targets one task; any other word is a factory filter passed as `--factory`;
    - it prints `factory: paused` / `factory: inactive` / `factory: nothing to do` from the CLI;
    - the build prompt takes the check commands from `context.checks`, and the skill no longer reads `repos/*.yaml`;
    - the spec prompt gives `context.factory.docsPath`, or says there are no background docs when it's empty.
  - **`/factory:new [--ready] [<factory>:] <prompt>`:**
    - it runs `factories --json` to learn the factories and their repos;
    - the factory is the `<factory>:` prefix if given, else inferred from a repo named in the prompt;
    - it asks when there's no match or more than one;
    - it passes `--factory`;
    - `link.mjs` adds `factory` to the fallback link.
  - **Spec skill:** "read the docs folder the prompt gives, if any".
  - **Build skill:** unchanged apart from where the commands come from.
  - **Factory root detection:** `plugin/hooks/lib.mjs` `isFactoryRoot` and `resolveFactoryRoot` change to: a factory root is a folder with `core/` and `plugin/`. `repos/` is no longer required, because `migrate` retires it. The guard's project-mode check follows. Tests:
    - a root without `repos/` resolves;
    - a folder with only `core/` doesn't.
- Tests: the structural tests assert:
  - `--factory` is passed;
  - `context.checks` is used and there's no `repos/` read;
  - `factories --json` is used in new;
  - the `<factory>:` prefix and the ambiguity question;
  - `link.mjs` encodes `factory`;
  - still no `$VAR` expansions, and the guard tests still pass.

- [ ] **Step 1:** Write the tests.
- [ ] **Step 2:** Run `cd plugin && npx vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement and update the README: factories, `--factory` in the loop, and the runner note.
- [ ] **Step 4:** Run `cd plugin && npx vitest run && claude plugin validate plugin && claude plugin validate .`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(plugin): factory arguments for run and new`.

### Task 10: Smoke run — two factories on the file store (executor)

**Files:**
- Create: `plugin/test/smoke/multi-factory.md` (commands and observed lines).

- [ ] **Step 1:** Set up a throwaway root `/private/tmp/factory-smoke-multi/`:
  - two bare repos;
  - `factories/a/` and `factories/b/`, each with repo `api` pointing at its own bare repo and no-op checks;
  - `b` with protected branches `rel`;
  - `core` and `plugin` symlinked;
  - build core first.
- [ ] **Step 2:** `FACTORY_STORE=file`: create one task in each factory with `factory new --factory a|b`, mark both ready (`dev ready`), then run `claude -p "/factory:run b"` with the same narrow `--allowedTools` as plan 4's smoke run. Expected:
  - only the `b` task moves to `spec_review`;
  - `.clones/b/api` exists, and `.clones/a` doesn't.
- [ ] **Step 3:** Run `claude -p "/factory:run"`. Expected: the `a` task moves next. Then `node core/dist/cli.js status` shows both factories.
- [ ] **Step 4:** Record what you saw, delete the root, and commit with `test(plugin): multi-factory smoke run`. At most 3 `claude -p` runs.

### Task 11 (USER live check): migrate, deploy and a second factory

The owner runs these steps, and the executor watches `factory status` and the Board.

1. Blocks first, in one sitting, in this order (see `docs/setup/blocks-project-setup.md` steps 3 and 4 for the exact commands):
   1. The schemas, fields and indexes: the three new tables `FactoryDef` (unique `factoryId`), `FactoryRepo` (unique `repoKey`) and `FactoryHealth` (unique `factoryId`), the new `factoryId` field on `FactoryTask` and `FactoryEvent`, and the `FactorySettings.scope` description. Each command runs `--dry-run` first, then `--yes` after the owner's OK.
   2. `blocks data rules deploy --yes` and `blocks data reload --yes` straight away (after the `--dry-run` diff of the three new tables, the two `factoryId` fields and the CLS change). Until the rules are deployed the new tables are open to any project user, and `FactoryRepo.checks` holds commands the core runs.
   3. The gate (the owner enters the password): steps 1–15 pass.
   4. Only then any core command against Blocks.
   5. No `/factory:run` with the new code (the owner's installed plugin included) until `factory migrate --check` shows `create-factory: already`.
2. The executor redeploys the Board (push `dev`, `blocks release deploy --wait`) after the owner's OK.
3. The migrate (R10 flow):
   1. `node core/dist/cli.js migrate --export <file>` writes the `blocks` factory and its repos as an import file (no secrets);
   2. on the Board, Settings → Factories → Import, with that file;
   3. `node core/dist/cli.js migrate --check` shows no step `pending` (`create-factory: already`, `gh-login: already`); there is no `--yes` step on the Blocks store;
   4. the owner removes `repos/` (`git rm -r repos`) in a normal session.
4. On the Board, the owner adds factory `tsf` (or `mods`) with a repo, and the factory names a gh login (`kazi-lakit`, or another account added with `gh auth login`). `factory status` shows `gh <ghUser> logged in`. Prerequisite: that repo needs a non-`main` base branch on GitHub (for example `dev`), because `main` is never a base; the factory's own repo has only `main` today.
5. `/factory:new tsf: <small change>`, then **Mark ready**, then `/factory:run tsf`, step by step until `pr_open` in that factory's repo.
6. Record the results in the vault overview (plan 6 section). On any failure, fix it and repeat the step.
