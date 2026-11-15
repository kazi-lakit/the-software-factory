# factory init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.


**Goal:** A fresh clone becomes a working factory with `./setup.sh` (or `setup.cmd`) and a question-and-answer `./factory init`. Factory config moves to one provider-neutral `factories/<id>/factory.yaml` that old files still load into, with a checks list that works for any repo.

**Architecture:**
- A pure normaliser (`factoryYaml.ts`) turns either YAML shape into today's internal `FactoryDef` / `FactoryRepo`, so the engine and stores barely change.
- In local mode the FileStore takes definitions, repos and gates from the YAML on every load. Its definition writes go through a Node config library (`factoryFile.ts`: load, named changes, save that keeps comments).
- The wizard (`core/src/init/`) is a thin question layer over that library. It uses Node readline numbered menus behind a `Prompter` interface, and small GitHub and gh clients behind interfaces, so tests drive it with scripted answers and fakes.
- `setup.sh` / `setup.cmd` bootstrap Node deps, build the core, write local `./factory` / `factory.cmd` launchers, install the plugin and start `./factory init`.

**Tech Stack:** TypeScript (Node >= 22, ESM), vitest, commander, zod, `yaml` (Document API), @octokit/rest; Board: React 18, @testing-library/react; plugin hooks: plain `.mjs`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-factory-init-design.md`. Section 14 (builder's calls 1-8) is binding and wins over sections 5-11 where they differ, in particular: no Board YAML import (call 7), new fields local-YAML-only (call 5), store selection (call 8).

## Global Constraints

- Node `>=22` (core `engines`); no new runtime dependency anywhere. The wizard uses `node:readline` with numbered menus.
- Models are Claude Code short names only: `opus | sonnet | haiku | fable` (`AGENT_MODELS`). No harness field, no exact model versions.
- `factory.source: local | factory-app`. `board.source: none | github | trello | jira | factory-app`. `board.mirror: none | github`. `trello`, `jira` and every repo host other than `github` fail validation with `<path>: <value> is not supported yet`.
- `board.source` defaults to `none`. A legacy file with no `github` block maps to `factory.source: local`, `board.source: none` (call 2).
- `main` is always a protected branch and never a base branch. The factory-wide default for protected branches is `[dev, stg, main]`.
- Store selection: `FACTORY_STORE=local | factory-app`, default `local`, with aliases `file` = `local` and `blocks` = `factory-app`. `--store` takes the same values. Inside the core the kinds stay `'file' | 'blocks'`.
- `FACTORY_STORE_LOCAL_PATH` moves only `board.json`, its lock and the pull locks. Empty means `<root>/.factory`. A relative path is refused with `FACTORY_STORE_LOCAL_PATH must be an absolute path`. The folder is created when missing.
- A command that names a factory (`--factory`) whose YAML says `factory.source: local` uses the local store, whatever `FACTORY_STORE` or `--store` says.
- The wizard never stores a token and sets no environment variable. Only logins go in `accounts`.
- Saving keeps a hand-edited file's comments and key order (yaml `Document` API). A save fails when the file changed since it was read.
- Nothing global gets installed. `./factory` and `factory.cmd` are generated in the clone and git-ignored.
- Existing behaviour for the Blocks store, the Board and the GitHub integration stays the same. App-mode factories keep today's fields; only the checks list reaches Blocks and the Board (call 5).
- Exact copy: the wizard's last line is `Ready. Open Claude Code and run /factory:run.`

## Review Focus

1. **A Blocks `FactoryRepo.checks` value that is corrupt or not JSON.** Today it decodes to `{}`, which validation skips. It must not now decode to `[]`, which is valid and would let every task pass the check step. The row must stay skipped (Task 5).
2. **A repo whose GitHub default branch is `main` (most new repos), on the wizard's default path.** The wizard must not write `baseBranch: main`. It uses `dev` when that branch exists, otherwise it asks for that one repo, refuses `main` and checks that the typed branch exists (Task 10).
3. **The user edits `factory.yaml` by hand while the wizard has it loaded, or between a store read and its save.** The save is refused with a version conflict and the hand edit survives. It is never silently overwritten (Task 6).
4. **A typo makes `factory.yaml` invalid after it has worked.** The factory must not quietly fall back to an older copy in `board.json`. It is left out, the reason names the file and field path, and `factory doctor` shows it with the fix (Tasks 2 and 9).
5. **The user presses Ctrl-C or closes stdin halfway through the first run.** Nothing is written: no half `factory.yaml`, no labels created. The wizard exits 130 with `setup cancelled; nothing was written` (Task 10).

---

## File Structure

Core (`core/src/`):
- `factoryYaml.ts` (new, pure): the YAML shape types, `normaliseFactoryYaml`, and the legacy-to-new mapping.
- `checksSchema.ts` (rewrite): both checks shapes in, a list out. `checks.ts`: runs the list.
- `factoriesFs.ts` (rewrite): loads one factory folder (new and old layout), with file-content versions.
- `store.ts`: FileStore source-of-truth merge, gates overlay, write-through.
- `storeSelect.ts` (new): parses the store kind, picks the store for named factories, and resolves the local store dir.
- `factoryFile.ts` (new, Node): the config library.
- `githubSetup.ts` (new): the GitHub calls the wizard and doctor need (Projects, repos, trees), with an Octokit implementation and a fake.
- `detectChecks.ts` (new, pure): detected checks from a repo's file list.
- `init/prompts.ts`, `init/ghCli.ts`, `init/shared.ts`, `init/firstRun.ts`, `init/menu.ts` (new): the wizard.
- `cli.ts`, `wire.ts`, `pullLock.ts`, `migrate.ts`, `doctor.ts`, `engine.ts`, `factories.ts`, `githubConfig.ts`, `blocks/store.ts`, `browser.ts`: smaller edits.

Elsewhere:
- `board-ui/src/features/settings/RepoForm.tsx`, `SettingsView.tsx` (`checksSummary`), `testChecks.ts`, `board-ui/src/test/factories.ts`.
- `plugin/hooks/lib.mjs`, `plugin/hooks/session-start.mjs`, `plugin/README.md`, `tools/watch.sh`.
- Root: `setup.sh`, `setup.cmd`, `.gitignore`, `README.md` (new, Getting started), `docs/setup/factory-yaml.md` (new, YAML reference with three templates).

---

### Task 1: Provider-neutral config shape and normaliser

**Files:**
- Create: `core/src/factoryYaml.ts`
- Modify: `core/src/githubConfig.ts` (add `STANDARD_STATUS_MAP`), `core/src/factories.ts` (`FactoryRepo.protectedBranches?`, `protectedFor`), `core/src/engine.ts` (the six `def.protectedBranches` uses at lines ~356, 386, 399, 531, 558, 642), `core/src/browser.ts` (exports)
- Test: `core/test/factoryYaml.test.ts`, `core/test/factories.test.ts`, `core/test/engine.test.ts`

**Interfaces:**
- Produces:
  - `export type FactorySource = 'local' | 'factory-app'`
  - `export type BoardSource = 'none' | 'github' | 'trello' | 'jira' | 'factory-app'`
  - `export interface BoardConfig { source: BoardSource; mirror: 'none' | 'github'; project: ProjectRef | null; label: string; approvers: string[]; statusMap: Record<Status, string> }`
  - `export interface FactoryYaml { shape: 'new' | 'legacy'; source: FactorySource; def: FactoryDef; repos: FactoryRepo[]; gates: Partial<Record<Gate, boolean>> | null; accounts: Record<string, string>; board: BoardConfig }`. `def.version` and each repo's `version` are `0` here; Task 2 sets them.
  - `export function normaliseFactoryYaml(raw: unknown): Validated<FactoryYaml>`. Errors read `<yaml.path>: <message>`.
  - `export const STANDARD_STATUS_MAP: Record<Status, string>` (call 4 names, in status order: Inbox, Ready, Spec, Spec review, Plan, Plan review, Build, Verify, Review, PR open, Done, Blocked, Cancelled).
  - `FactoryRepo.protectedBranches?: string[]` (only when a repo overrides; `ensureMain` applied). `validateFactoryRepo` accepts and validates it.
  - `export function protectedFor(def: FactoryDef, repo: Pick<FactoryRepo, 'protectedBranches'> | undefined): string[]`

- [ ] **Step 1: Write the failing tests** in `core/test/factoryYaml.test.ts`

```ts
test('new shape maps to the internal def and repos', () => {
  const r = normaliseFactoryYaml(parse(NEW_EXAMPLE)); // the section 5 example with baseBranch dev and statusMap left out
  expect(r.ok && r.value.def).toMatchObject({ factoryId: 'myapp', name: 'My App', ghUser: 'my-login', protectedBranches: ['dev', 'stg', 'main'],
    agentModels: { spec: 'opus', build: 'sonnet', verify: 'haiku' }, github: { mode: 'github-only', project: { owner: 'my-login', number: 7 }, statusMap: DEFAULT_STATUS_MAP } });
  expect(r.ok && r.value.repos[0]).toMatchObject({ repoId: 'web', baseBranch: 'dev', protectedBranches: ['main'] });
});
test('every legacy field maps', () => { /* ghUser→accounts.github, agentModels→factory.agents, gitName/gitEmail→def, protectedBranches, github-only→local+github, connected→factory-app+factory-app+mirror github */ });
test('a legacy file with no github block is local with board none', () => { expect(v.source).toBe('local'); expect(v.board.source).toBe('none'); expect(v.def.github).toBeUndefined(); });
test.each([
  [{ board: { source: 'trello' } }, 'board.source: trello is not supported yet'],
  [{ board: { source: 'factory-app' } }, 'board.source: factory-app needs factory.source factory-app'],
  [{ board: { source: 'github', mirror: 'github', project: 'a/1' } }, 'board.mirror: github needs board.source factory-app'],
  [{ accounts: {} }, 'accounts.github is required (used by: board, repos)'],
  [{ repos: { host: 'gitlab' } }, 'repos.host: gitlab is not supported yet'],
  [{ factory: { agents: { build: 'gpt' } } }, 'factory.agents.build: must be one of opus, sonnet, haiku, fable'],
  [{ repos: { list: [{ ...REPO, baseBranch: 'main' }] } }, 'repos.list[0].baseBranch: main is never a base'],
  [{ repos: { list: [REPO, REPO] } }, 'repos.list[1].id: duplicate repo id web'],
  [{ board: { statusMap: SAME_INBOX_READY } }, 'board.statusMap: inbox and ready must map to different options'],
])('refuses %j', (patch, error) => expect(normaliseFactoryYaml(merge(BASE, patch))).toEqual({ ok: false, error }));
test('gates are read in local mode and ignored for factory-app', () => { /* local: {spec:true,plan:false} kept; factory-app: null */ });
test('a per-repo protectedBranches override gets main added; the factory default applies otherwise', () => { /* repos[0].protectedBranches=['release','main']; repos[1] has none */ });
test('STANDARD_STATUS_MAP passes the status map rules', () => expect(validateGitHubSettings({ mode: 'github-only', project: 'o/1', statusMap: STANDARD_STATUS_MAP }, 'o').ok).toBe(true));
```

Add to `core/test/engine.test.ts`: `test('ship pushes with the repo protectedBranches override when it has one')`, which asserts that the fake git's `push` received `['release', 'main']`.

- [ ] **Step 2: Run** `cd core && npx vitest run test/factoryYaml.test.ts test/engine.test.ts`. Expected: FAIL (`normaliseFactoryYaml` not exported, override not used).

- [ ] **Step 3: Implement `normaliseFactoryYaml(raw)` in `core/src/factoryYaml.ts`** (pure, no Node API).
  - A top-level `factory` key holding an object means the new shape. Anything else is the legacy shape: run `validateFactoryDef` as today, then map it.
  - New shape: build the `validateFactoryDef` input from `factory.*`, `accounts.github` (as `ghUser`) and `repos.protectedBranches`. When `board.source` is `github` (mode `github-only`), or `factory-app` with `mirror: github` (mode `connected`), add `github` built from `board.*`.
  - Rewrite the `github.` prefix in errors to `board.`.
  - `accounts.github` is required when the board, the mirror or any repo host is `github`. With no GitHub use at all, `ghUser` falls back to `DEFAULT_GH_USER` as today.
  - Repos go through `validateFactoryRepo`, prefixed `repos.list[i].`.
  - The engine replaces `def.protectedBranches` with `protectedFor(def, repo)`, using the task's repo row.

- [ ] **Step 4: Run** the same command plus `npx vitest run test/factories.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/factoryYaml.ts core/src/githubConfig.ts core/src/factories.ts core/src/engine.ts core/src/browser.ts core/test/factoryYaml.test.ts core/test/factories.test.ts core/test/engine.test.ts
git commit -m "feat(core): provider-neutral factory.yaml shape and normaliser"
```

### Task 2: Load factory folders; the local-mode YAML is the source of truth

**Files:**
- Modify: `core/src/factoriesFs.ts`, `core/src/store.ts` (FileStore `upgrade`, `yamlKey`, `persist`, `getSettings`)
- Test: `core/test/factories.test.ts` (`loadFactoriesFromDir`), `core/test/store.test.ts` (`FileStore factories`)

**Interfaces:**
- Consumes: `normaliseFactoryYaml` (Task 1).
- Produces:
  - `export function yamlVersion(text: string): number`: the first 12 hex digits of the text's sha256, as an integer (call 3).
  - `export interface FactoryDirLoad { defs: FactoryDef[]; repos: FactoryRepo[]; gates: Record<string, Partial<Record<Gate, boolean>>>; owned: string[]; problems: { factoryId: string; file: string; reason: string }[] }`
  - `export function loadFactoriesFromDir(dir: string, onSkip?: (file: string, reason: string) => void): FactoryDirLoad`
    - `owned` lists every factory id with a `factory.yaml` that is not `factory-app`, including invalid ones.
    - A `factory-app` file is skipped with the reason `factory.source factory-app: the YAML is a template for the Board; skipped` (call 7).
    - `repos/*.yaml` files join the factory's repos. A clash with `repos.list` is a problem: `repo id <id> is in repos.list and repos/<id>.yaml`.
    - A def's version is `yamlVersion(factory.yaml)`. A repo's version is `yamlVersion` of the file that holds it.
  - `FileStore.factoryFileProblems(): { factoryId: string; file: string; reason: string }[]`: the problems from the last load (Task 9 uses it).

- [ ] **Step 1: Write the failing tests**

```ts
// factories.test.ts
test('a new-shape factory.yaml with repos.list loads, and old repos/*.yaml join it', ...);  // repos ['api','web']
test('versions are content hashes and change when the file changes', ...);
test('a factory-app factory.yaml is skipped with a note and is not owned', ...);
// store.test.ts: replaces 'seeds definitions ... then keeps what the owner saves'
test('a YAML-backed definition wins over the board.json copy on every load', ...);   // board.json name 'Old', YAML 'New' → 'New'
test('a definition in board.json with no YAML keeps loading from board.json', ...);  // call 3
test('an invalid factory.yaml hides the board.json copy and is reported with the file and field path', async () => {
  expect((await s.listFactoryDefs()).map((d) => d.factoryId)).toEqual([]);
  expect(s.factoryFileProblems()).toEqual([{ factoryId: 'delta', file: expect.stringMatching(/delta[\\/]factory\.yaml$/), reason: expect.stringContaining('factory.agents.build:') }]);
});
test('editing a repos/*.yaml file is picked up without touching factory.yaml', ...);   // yamlKey covers repo files
test('YAML gates win over board.json per gate; other settings stay from board.json', async () => {
  // YAML gates { plan: true }; board.json { gates: { spec: false, plan: false, pr: true }, maxParallel: 4 }
  expect((await s.getSettings()).factories.delta!.factory).toMatchObject({ gates: { spec: false, plan: true, pr: true }, maxParallel: 4 });
});
test('persisting a task write drops board.json copies of YAML-backed definitions', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/factories.test.ts test/store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `loadFactoriesFromDir` reads each `<dir>/<id>/factory.yaml` through `normaliseFactoryYaml`. The folder name must equal `def.factoryId` (today's message).
  - `FileStore.upgrade` builds `factoryDefs` / `factoryRepos` as the YAML defs and repos plus the board.json ones whose `factoryId` is not in `owned`. The empty-store seeding and the `github`-only overlay go away.
  - `yamlKey` also counts the mtimes of `repos/*.yaml`.
  - `persist` writes the state without defs and repos whose `factoryId` is owned.
  - `getSettings` overlays the YAML `gates` on each owned factory's `factory` scope, starting from `DEFAULT_SETTINGS` when the scope is missing.

- [ ] **Step 4: Run** the same tests, then `cd core && npx vitest run`. Expected: PASS. Fix any older test that relied on seeding-once and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add core/src/factoriesFs.ts core/src/store.ts core/test/factories.test.ts core/test/store.test.ts
git commit -m "feat(core): local-mode factory.yaml is the source of truth on every load"
```

### Task 3: Store selection, local store path, and plugin defaults (calls 1 and 8)

**Files:**
- Create: `core/src/storeSelect.ts`
- Modify: `core/src/cli.ts` (`--store` option and `open`), `core/src/wire.ts` (board.json path), `core/src/pullLock.ts` (lock dir), `core/src/migrate.ts:34` (board.json path), `plugin/hooks/lib.mjs` (`resolveFactoryRoot`, `renewCommand`), `plugin/hooks/session-start.mjs`, `tools/watch.sh` (default `local`)
- Test: `core/test/storeSelect.test.ts`, `core/test/cli.test.ts` (`describe('FACTORY_STORE')`), `core/test/pullLock.test.ts`, `plugin/test/session.test.mjs`

**Interfaces:**
- Produces:
  - `export type StoreKind = 'file' | 'blocks'`
  - `export function parseStoreKind(value: string): StoreKind`. It maps `local`/`file` to `file` and `factory-app`/`blocks` to `blocks`. Anything else throws `--store must be one of local, factory-app (or file, blocks)`.
  - `export function localStoreDir(root: string, env?: NodeJS.ProcessEnv): string`. It creates the folder, and throws on a relative path with the Global Constraints message.
  - `export function storeForFactories(kind: StoreKind, named: string[] | undefined, factoriesDir: string): StoreKind`. It returns `'file'` when every named factory has a `factory.yaml` that normalises (or fails to normalise) to `source: local`. When the named factories mix local and non-local, it throws `factories <a> (local) and <b> cannot run in one command`. Otherwise it returns `kind`.
  - `WireOptions` unchanged. `wire` uses `join(localStoreDir(o.root), 'board.json')`, and `fileLock(() => localStoreDir(findRoot()))` takes the store dir instead of the root.
  - Plugin: `resolveFactoryRoot(env, home, exists, read, pluginRoot = <folder two levels above lib.mjs's plugin dir>)` tries, in order, `FACTORY_ROOT`, `CLAUDE_PROJECT_DIR`, `pluginRoot`, then `<home>/scratchpad/selise/the-software-factory`. Session start exports `FACTORY_STORE="${FACTORY_STORE:-local}"`. `renewCommand` defaults to `local` and accepts `local | factory-app | file | blocks`.

- [ ] **Step 1: Write the failing tests**

```ts
// storeSelect.test.ts
test.each([['local','file'],['file','file'],['factory-app','blocks'],['blocks','blocks']])('parseStoreKind(%s)', (v, k) => expect(parseStoreKind(v)).toBe(k));
test('a relative FACTORY_STORE_LOCAL_PATH is refused; an absolute one is created', ...);
test('a named local factory uses the local store even when the kind is blocks', ...);
test('no named factory, or a factory without YAML, keeps the given kind', ...);
// cli.test.ts (replace the three FACTORY_STORE tests)
test('FACTORY_STORE defaults to local; factory-app and blocks open the Blocks store', ...);  // wired stores ['file','blocks','blocks']
test('an invalid value exits 1', ...);  // err ['error: --store must be one of local, factory-app (or file, blocks)']
test('next --factory <local yaml factory> opens the file store under FACTORY_STORE=blocks', ...);
// pullLock.test.ts
test('the pull lock lives in the store dir', ...);
// plugin/test/session.test.mjs
it('finds the root as the clone that holds the plugin, before the scratchpad fallback', ...);
it('exports FACTORY_STORE defaulting to local', ...);   // replaces the blocks default expectations
it('renew accepts local and factory-app and defaults to local', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/storeSelect.test.ts test/cli.test.ts test/pullLock.test.ts` and `cd plugin && npx vitest run test/session.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `--store` help text: `local | factory-app (aliases file, blocks)`, default `process.env.FACTORY_STORE || 'local'`.
  - `open(cmd)` computes `storeForFactories(parseStoreKind(g.store), cmd.opts().factory, join(root, 'factories'))`.
  - `storeKindOf` and `doctor`'s `choice(...)` read the kind from the same resolved value, so a named local factory gets the file pusher and the file doctor.

- [ ] **Step 4: Run** the same commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/storeSelect.ts core/src/cli.ts core/src/wire.ts core/src/pullLock.ts core/src/migrate.ts plugin/hooks/lib.mjs plugin/hooks/session-start.mjs tools/watch.sh core/test/storeSelect.test.ts core/test/cli.test.ts core/test/pullLock.test.ts plugin/test/session.test.mjs
git commit -m "feat: FACTORY_STORE local|factory-app, FACTORY_STORE_LOCAL_PATH, plugin finds its clone"
```

### Task 4: Checks for any repo (core)

**Files:**
- Modify: `core/src/checksSchema.ts`, `core/src/checks.ts`, `core/src/browser.ts` (export `normaliseChecks`, `Check`, `Checks`)
- Test: `core/test/checks.test.ts`, `core/test/factories.test.ts` (`validateFactoryRepo`), `core/test/repoConfig.test.ts`, `core/test/factoryFixtures.ts` (fixture to the list shape)

**Interfaces:**
- Produces:
  - `export interface Check { name: string; cwd: string; run: string; needs?: string }`
  - `export type Checks = Check[]`
  - `export const ChecksSchema`: a zod schema whose input is either shape and whose output is `Check[]`. `name` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$` and is unique. `cwd` keeps today's refine and defaults to `.` when left out. `run` is non-empty. `needs` names an earlier check.
  - `export function normaliseChecks(raw: unknown): Validated<Check[]>`: the same rules as plain errors (`checks.1.needs: build is not an earlier check`).
  - The old `{ server, client, e2e }` shape becomes, in order: `server.build`; `server.test` (needs `server.build`); `client.install`; then `client.typecheck`, `client.lint` and `client.test`, each needing `client.install`.
  - `runChecks(cfg: { checks: Checks }, worktree, exec)` keeps its signature. It runs the list in order and skips a check (`exitCode: null`) when its `needs` did not pass. An empty list gives `{ passed: true, steps: [] }`. `checks` stays required in `validateFactoryRepo`: a missing value is `checks is required`, and `[]` is valid.

- [ ] **Step 1: Write the failing tests**

```ts
test('the old shape converts to the same names and order as today', () =>
  expect(normaliseChecks(OLD).ok && normaliseChecks(OLD).value.map((c) => [c.name, c.needs ?? null])).toEqual([
    ['server.build', null], ['server.test', 'server.build'], ['client.install', null],
    ['client.typecheck', 'client.install'], ['client.lint', 'client.install'], ['client.test', 'client.install']]));
test('a failed check skips the checks that need it, others still run', ...);  // install fails → test skipped, lint (no needs) runs
test('a skipped check also skips its dependants', ...);
test('an empty list passes with no steps', ...);
test.each([
  [[{ name: 'a', run: 'x' }, { name: 'a', run: 'y' }], 'checks.1.name: duplicate check name a'],
  [[{ name: 'a', run: 'x', needs: 'b' }], 'checks.0.needs: b is not an earlier check'],
  [[{ name: 'a', run: 'x', cwd: '../up' }], 'checks.0.cwd: must be a folder inside the repo (relative, no ..)'],
])('refuses %j', (raw, error) => expect(validateFactoryRepo({ repoId: 'r', remote: 'x', checks: raw }, DEF)).toEqual({ ok: false, error }));
test('formatReport lists list-shaped steps as before', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/checks.test.ts test/factories.test.ts test/repoConfig.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema with `z.union([listSchema, oldSchema.transform(toList)])` plus a `superRefine` for unique names and earlier `needs`. Rewrite `runChecks` as a loop that keeps a set of the names that passed.
- [ ] **Step 4: Run** `cd core && npx vitest run && npm run typecheck`. Expected: PASS. `migrate.ts`'s `canonicalJson` comparison now compares lists on both sides; keep its test green.
- [ ] **Step 5: Commit**

```bash
git add core/src/checksSchema.ts core/src/checks.ts core/src/browser.ts core/test/checks.test.ts core/test/factories.test.ts core/test/repoConfig.test.ts core/test/factoryFixtures.ts
git commit -m "feat(core): repo checks are a named ordered list; the old shape converts"
```

### Task 5: Checks list in Blocks and the Board's repo form

**Files:**
- Modify: `core/src/blocks/store.ts` (`decodeRepo`), `board-ui/src/features/settings/RepoForm.tsx`, `board-ui/src/features/settings/SettingsView.tsx` (`checksSummary`), `board-ui/src/features/settings/testChecks.ts`, `board-ui/src/test/factories.ts`
- Test: `core/test/blocks/store.test.ts`, `board-ui/src/features/settings/FactoriesTab.test.tsx`, `board-ui/src/features/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `normaliseChecks`, `Check` (Task 4) through `@factory/core`.
- Produces:
  - `decodeRepo` parses the JSON text. A valid value of either shape becomes the list. JSON that does not parse, or that fails `normaliseChecks`, decodes to `null`, so `validateFactoryRepo` skips the row with `checks is required` (Review Focus 1).
  - No Blocks schema change: `FactoryRepo.checks` is already JSON text (design section 11, confirmed).
  - `checksSummary(c: Check[]): string` returns `c.map((x) => x.run).join(' · ')`, or `No checks` for an empty list.
  - The RepoForm shows one fieldset row per check.
    - Inputs are labelled `Check <n> name`, `Check <n> folder`, `Check <n> command` and `Check <n> needs`. The needs input is a select whose options are `None` plus the names of the earlier checks.
    - Buttons: `Add check`, `Remove check <n>`, `Move check <n> up`, `Move check <n> down`.
    - The old-beside-new review and **Confirm change** stay, showing the pretty JSON of the lists.

- [ ] **Step 1: Write the failing tests**

```ts
// core/test/blocks/store.test.ts
it('decodes an old-shape checks row as the list', ...);
it('a checks row that is not JSON, or not valid checks, is skipped, never read as no checks', async () => {
  // rows with checks '{nope' and '[{"name":""}]'
  expect(new FactoryConfig(await s.listFactoryDefs(), await s.listFactoryRepos()).repos('f')).toEqual([]);
});
// FactoriesTab.test.tsx (rewrite the four Checks (JSON) tests)
it('adds a repo with two checks, the second needing the first', ...);   // stored checks equal the list
it('reorders and removes checks', ...);
it('an old-shape repo opens as its six checks', ...);
it('saves_a_checks_change_only_after_confirm_change_and_records_a_history_event', ...);  // same name, list edits
// SettingsView.test.tsx
it('checks_summary_joins_commands_in_run_order', ...);  // still 'b · t · i · tc · l · t' from the list fixture; [] → 'No checks'
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/blocks/store.test.ts` and `cd board-ui && npx vitest run src/features/settings`. Expected: FAIL.
- [ ] **Step 3: Implement** `decodeRepo` and the form. The form's draft holds `Check[]` plus text inputs. On submit it validates through `validateFactoryRepo` as today and shows the first error under the checks fieldset. Change the fixtures to the list shape.
- [ ] **Step 4: Run** the same commands plus `cd board-ui && npm run lint && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add core/src/blocks/store.ts core/test/blocks/store.test.ts board-ui/src/features/settings board-ui/src/test/factories.ts
git commit -m "feat: checks list in Blocks rows and the Board repo form"
```

### Task 6: The config library (load, named changes, save keeping comments)

**Files:**
- Create: `core/src/factoryFile.ts`
- Test: `core/test/factoryFile.test.ts`

**Interfaces:**
- Consumes: `normaliseFactoryYaml` (Task 1), `yamlVersion` and the repo-file loading of `factoriesFs.ts` (Task 2), `Check` (Task 4), `VersionConflictError` from `boardStore.ts`.
- Produces:

```ts
export interface RepoEntry { id: string; remote: string; host?: 'github'; baseBranch: string; protectedBranches?: string[]; checks: Check[] }
export interface FactoryFile {
  dir: string; path: string; doc: Document; version: number; // yamlVersion of the text on disk; 0 for a new file
  shape: 'new' | 'legacy'; legacyRepoFiles: Record<string, string>; removedFiles: string[]; config: FactoryYaml;
}
export type ConfigChange =
  | { kind: 'setFactory'; name?: string; docsPath?: string; git?: { name: string; email: string }; active?: boolean }
  | { kind: 'setModels'; models: AgentModels }                       // {} removes factory.agents
  | { kind: 'setGates'; gates: Record<Gate, boolean> }
  | { kind: 'setAccounts'; accounts: Record<string, string> }
  | { kind: 'setBoard'; board: { source: 'none' } | { source: 'github'; project: string; label: string } }
  | { kind: 'setApprovers'; approvers: string[] }
  | { kind: 'setStatusMap'; statusMap: Record<Status, string> | null }  // null removes it (DEFAULT_STATUS_MAP)
  | { kind: 'setProtectedBranches'; branches: string[] }
  | { kind: 'addRepo'; repo: RepoEntry }
  | { kind: 'updateRepo'; repoId: string; patch: Partial<Omit<RepoEntry, 'id' | 'protectedBranches'>> & { protectedBranches?: string[] | null } }
  | { kind: 'removeRepo'; repoId: string }
  | { kind: 'convert' };
export function loadFactoryFile(dir: string): Validated<FactoryFile>;          // error: '<path>: <field.path>: <message>'
export function applyChange(file: FactoryFile, change: ConfigChange): Validated<FactoryFile>; // pure: clones doc, re-normalises
export function saveFactoryFile(file: FactoryFile): FactoryFile;               // sync; throws; returns the reloaded file
export function newFactoryFile(dir: string, init: NewFactory): Validated<FactoryFile>;
export interface NewFactory { id: string; name: string; accounts: Record<string, string>; board: { source: 'none' } | { source: 'github'; project: string; label: string; approvers: string[]; statusMap: Record<Status, string> | null };
  gates: Record<Gate, boolean>; models: AgentModels; protectedBranches: string[]; repos: RepoEntry[]; docsPath?: string; git?: { name: string; email: string } }
export function fileFromDefinition(dir: string, def: FactoryDef, repos: FactoryRepo[], gates: Record<Gate, boolean> | null): Validated<FactoryFile>; // call 3 export
export async function openTasksForRepo(store: BoardStore, factoryId: string, repoId: string): Promise<Task[]>; // not in TERMINAL
```

Rules the tests pin:
- Every change except `convert` on a `legacy` file returns `{ ok: false, error: '<path> is in the old format; convert it first' }`.
- `convert` writes the new shape and moves every `repos/*.yaml` into `repos.list`, adding those files to `removedFiles`. It keeps the top-of-file comment and the comments on the keys it carries over (best effort, section 15).
- `updateRepo` / `removeRepo` on a repo that lives in `repos/<id>.yaml` moves it into the list (or drops it) and adds that file to `removedFiles`.
- `saveFactoryFile` does these in order:
  1. Refuses a `legacy` file.
  2. Re-reads the file on disk. When its `yamlVersion` differs from `file.version` (or the file exists while `version` is `0`), it throws `VersionConflictError` with the message `<path> changed since it was read; reload and save again`.
  3. Writes `<path>.<pid>.<rand>.tmp`, then renames it over the file.
  4. Deletes `removedFiles`.
- `newFactoryFile` starts the document with the comment `# Written by factory init. Edit freely; ./factory init keeps your comments.` It writes `gates` and `factory.agents` only when they are not the defaults.

- [ ] **Step 1: Write the failing tests**

```ts
test('setModels keeps comments and the other lines byte for byte', () => {
  const before = readFileSync(path, 'utf8');            // fixture with a header comment and an inline '# main web app'
  const f = ok(applyChange(ok(loadFactoryFile(dir)), { kind: 'setModels', models: { build: 'haiku' } }));
  const after = readFileSync(saveFactoryFile(f).path, 'utf8');
  expect(after).toContain('# main web app');
  expect(after.replace(/agents:[\s\S]*?\n(?=\S)/, '')).toBe(before.replace(/agents:[\s\S]*?\n(?=\S)/, ''));
});
test.each(EVERY_CHANGE)('%s applies and re-validates', ...);               // one case per ConfigChange kind
test('an invalid change is refused with the field path and the file is untouched', ...);  // setApprovers(['bad login!'])
test('a hand edit after load makes the save throw and survives', () => {  // Review Focus 3
  const f = ok(applyChange(ok(loadFactoryFile(dir)), { kind: 'setGates', gates: { spec: false, plan: false, pr: true } }));
  appendFileSync(path, '# my note\n');
  expect(() => saveFactoryFile(f)).toThrow(VersionConflictError);
  expect(readFileSync(path, 'utf8')).toContain('# my note');
});
test('a legacy file must be converted first; convert moves repos/*.yaml into repos.list', ...);
test('updateRepo on a repos/<id>.yaml repo moves it into the list and deletes the file on save', ...);
test('newFactoryFile round-trips through loadFactoryFile', ...);
test('fileFromDefinition writes a board.json definition that loads back to the same def', ...);
test('openTasksForRepo lists open tasks of that repo only', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/factoryFile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `parseDocument`, `doc.clone()`, `setIn`, `deleteIn` and `getIn`. Re-normalise with `normaliseFactoryYaml(doc.toJS())` after each change.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add core/src/factoryFile.ts core/test/factoryFile.test.ts
git commit -m "feat(core): factory config library with named changes and comment-keeping save"
```

### Task 7: FileStore writes YAML-backed definitions through the library

**Files:**
- Modify: `core/src/store.ts` (FileStore overrides of `saveFactoryDef`, `saveFactoryRepo`, `updateSettingsScope`)
- Test: `core/test/store.test.ts`

**Interfaces:**
- Consumes: `loadFactoryFile`, `applyChange`, `saveFactoryFile` (Task 6); `owned` (Task 2).
- Produces the same `BoardStore` signatures. For an owned factory:
  - `saveFactoryDef(before, after)`:
    - A `before.version` that differs from the file's version throws `VersionConflictError`.
    - `before: null` while the YAML exists throws `factory <id> already exists; reload and save again`.
    - Otherwise it applies `setFactory`, `setModels`, `setAccounts({ github: after.ghUser })`, `setProtectedBranches` and the board change derived from `after.github`, saves, and returns the def with the new hash version.
  - `saveFactoryRepo(before, after)` maps to `addRepo` or `updateRepo` in the same way.
  - `updateSettingsScope(factoryId, before, after)` (factory scope only) compares `before` against the merged settings (YAML gates overlaid). It then writes `after.gates` to the YAML with `setGates` and the whole `after` to board.json. Repo scopes are unchanged.
  - A legacy-shape file refuses all three with `factories/<id>/factory.yaml is in the old format; run ./factory init to convert it`.
  - A factory that is not owned keeps today's board.json behaviour.

- [ ] **Step 1: Write the failing tests**

```ts
test('saveFactoryDef on a YAML-backed factory writes the YAML and returns the new hash version', ...);
test('saveFactoryDef with a stale version throws VersionConflictError', ...);
test('saveFactoryRepo adds a repo to repos.list', ...);
test('updateSettingsScope writes gates to the YAML and the rest to board.json', ...);  // then getSettings shows both
test('writes to a legacy-shape YAML factory are refused with the convert hint', ...);
test('a board.json-only factory still saves to board.json', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three overrides. Do the YAML work inside FileStore's `write()` lock, so YAML and board.json writes are serialised with other store writes.
- [ ] **Step 4: Run** `cd core && npx vitest run`. Expected: PASS (the store contract suite included).
- [ ] **Step 5: Commit**

```bash
git add core/src/store.ts core/test/store.test.ts
git commit -m "feat(core): local-mode definition and gate writes go to factory.yaml"
```

### Task 8: GitHub setup client and detected checks

**Files:**
- Create: `core/src/githubSetup.ts`, `core/src/detectChecks.ts`
- Test: `core/test/githubSetup.test.ts`, `core/test/detectChecks.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ProjectSummary { owner: string; number: number; title: string }
export interface GitHubSetup {
  viewer(): Promise<{ login: string; orgs: string[] }>;
  listProjects(owner: string): Promise<ProjectSummary[]>;          // open Projects of a user or org, all pages
  createProject(owner: string, title: string): Promise<ProjectSummary>;
  /** Adds missing options to the Status field and keeps the existing ones (their ids, so items keep their values). Returns the names added. */
  ensureStatusOptions(ref: ProjectRef, names: string[]): Promise<string[]>;
  repo(r: RepoRef): Promise<{ defaultBranch: string } | null>;    // null: not found or not visible
  branchExists(r: RepoRef, branch: string): Promise<boolean>;
  listFiles(r: RepoRef, ref: string): Promise<string[]>;           // blob paths, recursive tree
  readFile(r: RepoRef, ref: string, path: string): Promise<string | null>;
}
export type GitHubSetupFor = (login: string) => GitHubSetup;
export class OctokitGitHubSetup implements GitHubSetup { constructor(token: string, opts?: { fetch?: typeof fetch }) }
export class FakeGitHubSetup implements GitHubSetup { /* public maps: projects, repos, files; records added options */ }
export function lazyGitHubSetupFor(read?: (login: string) => Promise<string>): GitHubSetupFor;  // token via readGhToken, one client per login
export async function detectChecks(files: string[], read: (path: string) => Promise<string | null>): Promise<Check[]>;
```

Detection rules (section 7.3; the extra choices are this plan's):
- Look at the repo root and at first-level folders only.
- A folder's checks are named `<step>` at the root and `<folder>.<step>` in a subfolder, with `cwd` `.` or `<folder>`.
- `package.json`:
  - The install command depends on the lockfile: `package-lock.json` gives `npm ci`, `pnpm-lock.yaml` gives `pnpm i --frozen-lockfile`, `yarn.lock` gives `yarn --frozen-lockfile`, and no lockfile gives `npm install`.
  - Then come the `typecheck`, `lint`, `test` and `build` scripts that exist, in that order, run as `npm run <s>` / `pnpm run <s>` / `yarn <s>`. Each one needs install.
- `*.sln` / `*.csproj`: `dotnet build`, then `dotnet test` (needs build).
- `go.mod`: `go build ./...`, then `go test ./...` (needs build).
- `Cargo.toml`: `cargo build`, then `cargo test` (needs build).
- `pyproject.toml` / `requirements*.txt`: `pytest`, only when one of those files mentions `pytest`.
- A `Makefile` with a `test:` target gives `make test`, only when nothing else was found in that folder.
- Nothing found gives `[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test('npm with a lockfile: npm ci then the scripts that exist, in order', async () =>
  expect(await detectChecks(['package.json', 'package-lock.json'], readOf({ 'package.json': '{"scripts":{"test":"v","lint":"e","build":"b"}}' }))).toEqual([
    { name: 'install', cwd: '.', run: 'npm ci' }, { name: 'lint', cwd: '.', run: 'npm run lint', needs: 'install' },
    { name: 'test', cwd: '.', run: 'npm test', needs: 'install' }, { name: 'build', cwd: '.', run: 'npm run build', needs: 'install' }]));
test('monorepo with server (dotnet) and client (pnpm) gets prefixed names and cwds', ...);
test.each(['go.mod', 'Cargo.toml', 'api.sln'])('%s gives build then test', ...);
test('pytest only when mentioned; make test only when nothing else matched', ...);
test('nothing found is an empty list', ...);
// githubSetup.test.ts, with a fetch stub as in githubBoard.test.ts
test('listProjects pages through a user and an org', ...);
test('ensureStatusOptions sends existing options with their ids plus the missing names and returns only the added', ...);
test('repo returns null on 404 and the default branch otherwise', ...);
test('listFiles reads the recursive tree and keeps blobs only', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/detectChecks.test.ts test/githubSetup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use GraphQL for Projects: `createProjectV2` needs the owner's node id, and `updateProjectV2Field` takes `singleSelectOptions`.
  - Before relying on the option-id behaviour, check GitHub's current docs to confirm that `updateProjectV2Field` keeps the options passed with their `id`. If it does not, stop and report it, because replacing the options would clear the Status values of existing items.
  - Use REST for repos, branches, trees (`?recursive=1`) and contents.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add core/src/githubSetup.ts core/src/detectChecks.ts core/test/githubSetup.test.ts core/test/detectChecks.test.ts
git commit -m "feat(core): GitHub setup client and detected repo checks"
```

### Task 9: Doctor additions

**Files:**
- Modify: `core/src/doctor.ts`, `core/src/cli.ts` (`doctor` command)
- Test: `core/test/doctor.test.ts`, `core/test/cli.test.ts`

**Interfaces:**
- Consumes: `FileStore.factoryFileProblems()` (Task 2), `GitHubSetupFor` (Task 8).
- Produces: new optional fields on `doctor()`'s argument, `setupFor?: GitHubSetupFor` and `fileProblems?: { factoryId: string; file: string; reason: string }[]`. New checks, in order per factory:
  - `config file` (fail): `<file>: <reason>; fix the file or run ./factory init`. There is one per problem, and it is listed even though the factory has no def.
  - After `gh login` passes, and only when `setupFor` is given, these run for every repo, whether or not the factory has `github`, in repoId order:
    - `repo <id>`: `<o/r> reachable as <login>`, or one of the failures `remote is not a GitHub repo (only GitHub is supported)` and `<o/r> not found or not visible to <login>`.
    - `base <id>`: `<branch> exists`, or the failure `base branch <branch> not found on <o/r>`.
  - The existing checks and their order stay. CLI `doctor` passes `fileProblems` only for the file store, and `setupFor: deps.githubSetupFor ?? lazyGitHubSetupFor()`. The new `CliDeps.githubSetupFor?: GitHubSetupFor` is the test seam.

- [ ] **Step 1: Write the failing tests**

```ts
test('a factory.yaml problem is a failing config file check with the fix', ...);  // Review Focus 4
test('repo and base checks per repo, in repoId order, for a factory without github', ...);
test('an unreachable repo fails repo and skips base', ...);
test('without setupFor no repo checks run (old callers unchanged)', ...);
// cli.test.ts
test('doctor prints FAIL for an invalid factory.yaml and exits 1', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/doctor.test.ts test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the repo checks before the `if (!github) continue;` line. Keep the label checks where they are.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add core/src/doctor.ts core/src/cli.ts core/test/doctor.test.ts core/test/cli.test.ts
git commit -m "feat(core): doctor checks factory.yaml, repo access and base branches"
```

### Task 10: Wizard prompts and first run

**Files:**
- Create: `core/src/init/prompts.ts`, `core/src/init/ghCli.ts`, `core/src/init/shared.ts`, `core/src/init/firstRun.ts`
- Test: `core/test/init/prompts.test.ts`, `core/test/init/firstRun.test.ts`

**Interfaces:**
- Consumes: `newFactoryFile`, `saveFactoryFile` (Task 6); `GitHubSetupFor`, `detectChecks` (Task 8); `GitHubBoardFor` (`tokenScopes`, `labelExists`, `createLabel`); `DoctorCheck`; `STANDARD_STATUS_MAP`, `DEFAULT_STATUS_MAP`, `DEFAULT_LABEL`; `isValidId`, `RESERVED_ID`, `isMainRef`, `parseRemote`.
- Produces:

```ts
// prompts.ts
export class PromptClosedError extends Error {}           // Ctrl-C or end of input
export interface Prompter {
  say(text: string): void;
  ask(question: string, o?: { default?: string; validate?: (v: string) => string | null }): Promise<string>;  // re-asks with the message
  choose<T extends string>(question: string, options: { value: T; label: string }[], o?: { default?: T }): Promise<T>; // numbered, 1-based
  confirm(question: string, def: boolean): Promise<boolean>;  // y/n, empty = def
  lines(question: string): Promise<string[]>;                // until an empty line
}
export function readlinePrompter(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Prompter & { close(): void };
export function scriptedPrompter(answers: string[]): Prompter & { transcript: string[] };  // throws PromptClosedError when answers run out
// ghCli.ts
export interface GhCli { logins(): Promise<string[]>; login(): Promise<void>; refreshProjectScope(login: string): Promise<void> }
export function realGhCli(exec?: ExecFile): GhCli;  // login/refresh spawn gh with stdio 'inherit'; refresh runs `gh auth switch --user <login>` first when there are several logins
// shared.ts
export interface InitDeps {
  root: string; prompt: Prompter; gh: GhCli; boardFor: GitHubBoardFor; setupFor: GitHubSetupFor;
  openStore: () => Promise<BoardStore>;                      // the local FileStore (localStoreDir)
  doctor: (factoryId: string) => Promise<DoctorCheck[]>;
  platform: NodeJS.Platform; now: () => Date;
}
export async function chooseLogin(d: InitDeps): Promise<string>;                 // step 1
export async function askRepos(d: InitDeps, login: string, factoryDefaults: string[], existingIds: string[]): Promise<RepoEntry[]>; // step 8
export async function checkUntilClean(d: InitDeps, factoryId: string): Promise<boolean>;  // step 11 loop
export function idFromName(name: string, taken: string[]): string;
// firstRun.ts
export async function firstRun(d: InitDeps): Promise<number>;  // 0 ready, 1 stopped with failures, 130 cancelled
```

Flow (section 7.2; the choices the design leaves open are fixed here):
1. **Login.** With no gh login, run `gh.login()` and list again. With several, use `choose`. When `tokenScopes()` lacks `project` (or is `null`), run `refreshProjectScope` and check again; a second failure stops with exit 1 and the gh command to run.
2. **Name and id.** Ask the name, then the id with default `idFromName(name, taken)`. The id is validated with `isValidId`, must not be `global`, and must not already be a factory dir or a board.json def.
3. **Project.** Offer a numbered list over `listProjects` for the login and each org, plus `Create a new Project`. A new Project asks for its owner (the login or an org) and a title (default: the factory name).
4. **Approvers.** Comma-separated; the default is the login.
5. **Status map.**
   - A new Project gets `STANDARD_STATUS_MAP` with no question.
   - An existing Project that has every `DEFAULT_STATUS_MAP` option is asked `Use the default map (Backlog, Todo, In progress, In review, Merged)?`.
   - Otherwise, or on no, the wizard asks each status with `choose`, over the Project's options plus `New column…` (which asks for a name). A map that breaks the rules shows the error and asks the whole map again.
6. **Gates.** Three `confirm`s, defaulting to spec on, plan off and PR on.
7. **Models.** `Session model for every stage`, or `Choose per stage`, which offers `session, opus, sonnet, haiku, fable` for each stage.
8. **Repos.** Read links with `lines`.
   - Accepted forms: `git@github.com:o/r(.git)`, `https://github.com/o/r(.git)` and `o/r`. The shorthand `o/r` is stored as `git@github.com:o/r.git`.
   - The id is `idFromName(repo name)`.
   - Every repo must be reachable through `setup.repo`; any bad line re-asks the whole list, naming the bad lines.
   - Then `Default setup` or `Custom setup`. Default: base = the default branch. When that is `main`, use `dev` if `branchExists`, else ask for this repo only; the answer may not be `main` and must exist (Review Focus 2). Protected branches = the factory default. Checks = `detectChecks`, saying `no checks found for <id>` when the list is empty.
   - Custom asks, per repo, for the base, the protected branches and the checks, starting from the detected ones with a menu to add, edit, remove or keep them.
9. **Write.** Build with `newFactoryFile`, then `saveFactoryFile`. Nothing is written or created before this step, so a `PromptClosedError` at any earlier point exits 130 with `setup cancelled; nothing was written` (Review Focus 5).
10. **Labels and columns.** `createLabel` for each repo whose label is missing, then `ensureStatusOptions` with the map's option names.
11. **Doctor.** `checkUntilClean` prints each failure as `FAIL <check>: <detail>` and asks `Retry the checks?`. On no it returns `false`, and `firstRun` prints `Fix the failures above, then run ./factory init and choose Re-check.` and exits 1.
12. **Done.** Print `Ready. Open Claude Code and run /factory:run.` On `win32`, then print `Note: the factory steps themselves (git worktrees, the guard hook, shell checks) have not been tested on Windows yet.`

- [ ] **Step 1: Write the failing tests** (temp root, `scriptedPrompter`, fakes for gh, board, setup, doctor)

```ts
// prompts.test.ts
test('choose shows numbered options and re-asks on a bad number', ...);
test('ask re-asks with the validate message', ...);
test('readlinePrompter throws PromptClosedError when input ends', ...);
// firstRun.test.ts
test('default path writes a factory.yaml that loads, creates labels and columns, and ends Ready', async () => {
  const code = await firstRun(deps(SCRIPT_DEFAULT_PATH)); // name 'My App', default id, Create a new Project, defaults, repo 'o/web' (default branch main, dev exists), Default setup
  expect(code).toBe(0);
  const f = ok(loadFactoryFile(join(root, 'factories', 'my-app')));
  expect(f.config.board.statusMap).toEqual(STANDARD_STATUS_MAP);
  expect(f.config.repos[0]).toMatchObject({ repoId: 'web', baseBranch: 'dev', checks: [{ name: 'install', run: 'npm ci' }, expect.anything()] });
  expect(fakeSetup.addedOptions).toEqual([...new Set(Object.values(STANDARD_STATUS_MAP))]);
  expect(fakeBoard.labels).toContainEqual({ repo: 'o/web', name: 'factory' });
  expect(transcript.at(-1)).toBe('Ready. Open Claude Code and run /factory:run.');
});
test('no gh login runs gh auth login; a missing project scope runs the refresh', ...);
test('a repo whose default branch is main uses dev when it exists, else asks and refuses main', ...);  // Review Focus 2
test('custom path: edited checks, base and protected branches land in the file', ...);
test('existing Project with the five default columns: yes keeps statusMap out of the file', ...);
test('per-status map that breaks the rules is asked again', ...);
test('input closing before the write leaves no factory folder and exits 130', ...);   // Review Focus 5
test('doctor failures: retry re-runs doctor; no exits 1 with the hint', ...);
test('on win32 the Windows note follows Ready', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/init`. Expected: FAIL.
- [ ] **Step 3: Implement** the four modules. `readlinePrompter` uses `node:readline/promises`. On `SIGINT` or `close` it rejects the pending question with `PromptClosedError`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add core/src/init core/test/init
git commit -m "feat(core): factory init first run (readline wizard over the config library)"
```

### Task 11: Wizard menu for later runs

**Files:**
- Create: `core/src/init/menu.ts`
- Test: `core/test/init/menu.test.ts`

**Interfaces:**
- Consumes: `InitDeps`, `chooseLogin`, `askRepos`, `checkUntilClean` (Task 10); `firstRun`; `loadFactoryFile`, `applyChange`, `saveFactoryFile`, `fileFromDefinition`, `openTasksForRepo` (Task 6); `owner.cancelTask`.
- Produces: `export async function runInit(d: InitDeps): Promise<number>`.
  - With no factory (no factory dir and no board.json def), it runs `firstRun`.
  - With several factories, it asks which one first. Its list holds every `factories/<id>` folder and every board.json-only def, marked `(board.json)`.
  - Menu items (numbered) and the change each one applies:
    - `Change models`: `setModels`
    - `Change gates`: `setGates`
    - `Change approvers`: `setApprovers`
    - `Change status map`: `setStatusMap`, same questions as the first run, step 5
    - `Add a repo`: `askRepos`, then `addRepo` per repo
    - `Change a repo`: pick a repo, then base, protected branches or checks, then `updateRepo`
    - `Remove a repo`: `removeRepo`, guarded (below)
    - `Add another factory`: `firstRun`, minus the login question when one login is already used
    - `Re-check`: doctor only
    - `Quit`
  - Each item prints the current value first, saves, then runs `checkUntilClean`.
  - **Remove a repo** first calls `openTasksForRepo`. With open tasks it lists them (`T-n <status> <title>`) and offers `Cancel these tasks, then remove the repo` / `Keep the repo`.
  - **A legacy file** is asked first: `This file is in the old format. Convert it (and move repos/*.yaml into it)?`. Yes applies `convert` and saves. No goes back to the factory choice without changes.
  - **A board.json-only factory** offers only `Export to YAML` (`fileFromDefinition` with its stored gates), `Re-check` and `Quit`. After the export it gets the full menu.
  - A `VersionConflictError` on save prints `factory.yaml changed while you were answering; nothing was saved. Run the item again.` and returns to the menu.
  - `PromptClosedError` exits 130.

- [ ] **Step 1: Write the failing tests**

```ts
test('change models saves only factory.agents and re-runs doctor', ...);
test('change gates, approvers and status map each apply their change', ...);
test('add a repo appends to repos.list with detected checks', ...);
test('change a repo updates its base and checks', ...);
test('remove a repo with open tasks lists them; cancel then remove cancels and removes', ...);
test('remove a repo with open tasks; keep leaves file and tasks unchanged', ...);
test('a legacy file is converted after asking; declining changes nothing', ...);
test('a board.json-only factory can only be exported, then gets the full menu', ...);
test('a hand edit during an item makes the save report the conflict and keep the edit', ...);
test('add another factory runs the first-run questions and leaves the first factory alone', ...);
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/init/menu.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `runInit` and the item handlers. Each handler is `(d, file) => Promise<ConfigChange | null>`, and a single save path applies the change.
- [ ] **Step 4: Run** `cd core && npx vitest run test/init`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add core/src/init/menu.ts core/test/init/menu.test.ts
git commit -m "feat(core): factory init menu for later runs"
```

### Task 12: `factory init` command, setup scripts, launchers and docs

**Files:**
- Modify: `core/src/cli.ts` (the `init` command), `.gitignore` (add `/factory` and `/factory.cmd`), `plugin/README.md` (installation now comes from setup, and the root comes from the clone)
- Create: `setup.sh`, `setup.cmd`, `README.md`, `docs/setup/factory-yaml.md`
- Test: `core/test/cli.test.ts`, `core/test/setup.test.ts`, `core/test/docsTemplates.test.ts`

**Interfaces:**
- Consumes: `runInit`, `readlinePrompter`, `realGhCli` (Tasks 10-11); `lazyGitHubBoardFor`; `lazyGitHubSetupFor`; `localStoreDir`; `doctor`.
- Produces:
  - `factory init` builds `InitDeps` from the real clients. It always opens the local FileStore (`localStoreDir(root)`, `factories/`), whatever `--store` says, and exits with `runInit`'s code. `CliDeps.runInit?: (d: InitDeps) => Promise<number>` is the test seam.
  - `setup.sh` (POSIX `sh`) and `setup.cmd` (cmd.exe) do these steps:
    1. Check `node` >= 22, `git`, `claude` and `gh`. A missing tool prints `<tool> is missing: install it from <url>` and exits 1. The URLs: nodejs.org, git-scm.com, `https://docs.claude.com/claude-code`, cli.github.com.
    2. Run `npm ci` in `core` and `plugin`, then `npm run build` in `core` (call 1).
    3. Write `./factory` (mode 755) and `factory.cmd`. Each sets `FACTORY_ROOT` to its own folder and runs `node <root>/core/dist/cli.js "$@"` (or `%*`).
    4. Install the plugin unless `claude plugin list` already shows `factory@the-software-factory`, with `claude plugin marketplace add <root>` and `claude plugin install factory@the-software-factory`. Check the list command's exact name and output with `claude plugin --help` while implementing.
    5. Run `./factory init` (or `factory.cmd init`).
  - Every step checks before it acts, so a second run is safe. `setup.cmd` also prints the Windows note from Task 10 before starting init.
  - `README.md` gets a short "Getting started": clone, `./setup.sh` or `setup.cmd`, then `./factory init` again to change settings, then `/factory:run`. It links the YAML reference.
  - `docs/setup/factory-yaml.md` has the field reference (section 5 rules, the checks list, store variables) and three fenced `yaml` templates titled `App only`, `App + GitHub` and `Local + GitHub`.

- [ ] **Step 1: Write the failing tests**

```ts
// cli.test.ts
test('init runs the wizard on the local store even when FACTORY_STORE=blocks', ...);  // runInit seam receives root; wired store untouched
// setup.test.ts (skipped on win32): temp copy of setup.sh; PATH holds stub npm/claude/gh/git that log argv, real node, stub core/dist/cli.js that logs
test('first run: npm ci in core and plugin, build, launchers, plugin install, then init', ...);
test('second run skips the plugin install when claude plugin list shows it', ...);
test('a missing gh stops with the install hint and exit 1', ...);
test('./factory sets FACTORY_ROOT to the clone and forwards arguments', ...);
// docsTemplates.test.ts
test('each template in docs/setup/factory-yaml.md normalises', () => {
  const blocks = yamlBlocks(readFileSync(DOC, 'utf8'));
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  for (const block of blocks) expect(normaliseFactoryYaml(parse(block)).ok).toBe(true);
});
```

- [ ] **Step 2: Run** `cd core && npx vitest run test/cli.test.ts test/setup.test.ts test/docsTemplates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the command, both scripts, the `.gitignore` lines and the docs. `setup.cmd` uses CRLF line endings and `where` for the tool checks.
- [ ] **Step 4: Run** `cd core && npx vitest run && npm run typecheck && npm run build`, `cd plugin && npx vitest run` and `cd board-ui && npx vitest run && npm run lint`. Expected: all PASS.
- [ ] **Step 5: Commit**

```bash
git add core/src/cli.ts core/test/cli.test.ts core/test/setup.test.ts core/test/docsTemplates.test.ts setup.sh setup.cmd .gitignore README.md docs/setup/factory-yaml.md plugin/README.md
git commit -m "feat: factory init command, setup.sh/setup.cmd, local launchers, Getting started"
```

---

## Owner manual checklist (after Task 12, not automated)

- [ ] Mac: fresh `git clone` into a new folder, `cd`, `./setup.sh` with `FACTORY_STORE` unset. It installs, builds, installs the plugin and starts the wizard.
- [ ] Linux: the same on a machine or VM with Node 22, git, gh and Claude Code.
- [ ] Windows: `setup.cmd` in cmd.exe from a fresh clone writes `factory.cmd`, shows the Windows note, and starts `factory.cmd init`; the numbered menus work in the console.
- [ ] Wizard first run against a throwaway GitHub Project (create it from the wizard) and a throwaway repo whose default branch is `main`: 13 columns are created, the `factory` label exists, the base branch question appears, and doctor is all `ok`.
- [ ] `./setup.sh` a second time skips the done steps. `./factory init` shows the menu, and changing models leaves your hand-written comments in `factory.yaml`.
- [ ] In the owner's own shell with `FACTORY_STORE=blocks`: `/factory:run` on the Blocks factories behaves as before, and `factory doctor --store blocks` is unchanged.
- [ ] `/factory:run` in the fresh clone picks up a task created on the throwaway Project.
