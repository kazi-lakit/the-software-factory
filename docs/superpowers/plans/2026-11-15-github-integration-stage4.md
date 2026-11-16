# GitHub Integration Stage 4 (Connected Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Board factory can be connected to a GitHub Project. Tasks created or changed on the Board reach GitHub within seconds through `factory sync --watch --store blocks`. GitHub changes come back only when the owner clicks **Sync with GitHub**: the watcher works out the change set, and the Board, signed in as the owner, applies it. Cards show `#<n>`, **waiting for GitHub**, or the stuck push error. The GitHub settings live in a section of the Board's factory settings.

**Architecture:** This stage reuses the stage 2 pusher and the stage 3 pure planner and applier (`githubPull.ts`, `githubPullApply.ts`).
1. **Blocks Data:** two new tables (`FactoryGitHubLink`, `FactorySyncRequest`), plus new columns on `FactoryDef` (`github`) and on `FactoryHealth` (`watcherSeenAt`, `githubProblems`). `BlocksStore` probes for them once. Until the owner applies the schema change, every GitHub read is empty and every GitHub write is refused with one fixed message, so the Board and the CLI keep working.
2. **Core, Node:** a `GitHubWatcher` (`githubWatcher.ts`) runs each `factory sync` pass on the Blocks store. It pushes the connected factories, turns each queued sync request into a planned change set, applies the core-only parts of that set itself (`block`, link patches), and writes factory health.
3. **Core, pure:** `githubSync.ts` holds the sync request types and state moves, plus `applySyncRequest`. The Board calls `applySyncRequest` to claim a planned row, run its actions through `applyPull` as the owner, and store the result.
4. **Board:** a GitHub section in the factory form, a watcher last-seen chip, card states, a Sync button with its result panel, and a hook that applies pending change sets whenever the Board page is open.

**Tech Stack:** TypeScript (Node ≥22, ESM), vitest, commander, @octokit/rest; Board: React 18, @tanstack/react-query, @testing-library/react, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-github-board-integration-design.md` (sections 5, 6.2, 8.1-8.4, 9, 11, 12, 13 stage 4). Inputs: `runs/design/stage4-inputs.md`. Stage 3 plan (style, pull design): `docs/superpowers/plans/2026-11-15-github-integration-stage3.md`.

## Builder's calls (for the owner to check)

1. **Tables and who writes what (option A).**
   - `FactoryGitHubLink`: one row per task (unique `taskId`) with `factoryId`, `json` (the `GitHubLink` without `taskId`, `factoryId` and `version`), `version` and `writeId`. Both roles read it; only `factory-core` inserts and edits.
   - `FactorySyncRequest`: unique `requestId`, plus `factoryId`, `requestedAt`, `requestedBy`, `state`, `plan` (JSON), `plannedAt`, `applyingSince`, `result` (JSON), `appliedAt`, `error`, `version` and `writeId`. Both roles read it, only `factory-owner` inserts, and both edit.
   - Blocks can't limit which state moves each role makes, so `BlocksStore.saveSyncRequest` enforces `SYNC_MOVES` (call 4) for its identity.
   - The `factory-core` role gains no right on `FactoryTask`, `FactoryApproval` or `FactoryDef`.
   - Cost if wrong: a buggy Board could overwrite a plan, or a buggy core could overwrite a result. Both are factory code. The worst case is one failed Sync, and no task data is at risk.
2. **The link stays a separate record** (the stage 2 call), now stored in `FactoryGitHubLink`. It does not join `CORE_TASK_FIELDS` as spec 8.3 sketched: a task write never touches it, and the Board reads it only to draw cards. Cost if wrong: one extra list query on each Board refresh (30 s).
3. **New columns.**
   - `FactoryDef.github` holds the `GitHubSettings` as JSON text, and `''` means no GitHub. It is always written while the schema is ready, so turning GitHub off clears it (Blocks ignores a null in an update).
   - `FactoryHealth.watcherSeenAt` holds ISO text.
   - `FactoryHealth.githubProblems` holds a JSON array of strings.
   - `setFactoryHealth` writes `watcherSeenAt`/`githubProblems` only when they are present on its argument, so `factory status` doesn't wipe what the watcher wrote.
   - Cost if wrong: one schema re-apply.
4. **Sync request lifecycle.**
   - States are `queued` → `planned` | `failed`, then `planned` → `applying` → `applied` | `failed`.
   - `SYNC_MOVES.core` = queued→planned, queued→failed, planned→failed, applying→failed. `SYNC_MOVES.owner` = planned→applying, applying→applied, applying→failed.
   - Per factory, the watcher plans only the newest `queued` row. Older `queued` rows and any earlier `planned` row fail with `superseded by a newer Sync`.
   - It plans nothing for a factory while one of its rows is `applying` and that row's `applyingSince` is under `SYNC_APPLY_MS` = 120 s old. An older `applying` row fails with `interrupted while applying; click Sync again`.
   - The Board applies only the newest `planned` row.
   - Cost if wrong: an interrupted apply needs one more click. Nothing is applied twice (call 6).
5. **Splitting the change set.**
   - The watcher runs `planPull`. It applies the `block` actions itself, as the core (the owner has no right to block). It also saves the not-applied link patches (`link.option`, `link.report`) itself, because they don't depend on the Board.
   - It writes the rest to the row as a `SyncPlan { actions, notApplied, done, errors }`. Here `done`/`errors` are what the factory machine already did or hit.
   - `onApplied` link patches are dropped in connected mode. After a Board `ready` or `edit`, the next push sees `pushed.status`/`title` behind the task and writes the same value to GitHub once (and writes the marker for an edit). This is idempotent.
   - `applySyncRequest` refuses any `block` action as not applied: `the factory machine applies this`.
   - Cost if wrong: one redundant `setStatus` or `updateIssue` call per applied action.
6. **Tasks created from GitHub get their link from their create event.**
   - The Board's `createTaskFromGitHub` writes a `create` event with actor `github` and reason `created from GitHub issue <o/r#n>`, and `createdFromIssue(events)` reads it back.
   - In connected mode, the pusher **adopts** that issue for an unlinked task with such an event, instead of creating one. It saves `issueNumber`/`issueNodeId`/`itemId` from the Project item, with `pushed.bodyHash: null` so the next action writes the marker.
   - A task with no events at all is skipped as `waiting`. That is the moment between the Board's task insert and its event write. A task that has events but no create event is treated as created on the Board.
   - When planning, the watcher passes the issues of not-yet-adopted GitHub-created tasks as `PullInput.pendingIssues`, and the planner skips them. A second Sync can't create a second task.
   - Cost if wrong: a legacy task with no events at all stays "waiting for GitHub" until its first edit or move.
7. **Watcher tick (per `factory sync` pass on `--store blocks`).**
   1. If `githubSchemaReady()` is false, print the schema message once (one-shot: exit 1) and do nothing else.
   2. Push every connected factory's tasks (`storeKind: 'blocks'`).
   3. Handle the sync requests of each connected factory, under the pull lock.
   4. Write health when 30 s have passed since this process last wrote it (`WATCHER_HEALTH_MS`).

   The default interval stays 5 s, which keeps both a Sync and a push within the spec 14 target of about 5 s. Cost if wrong: a slower Sync, tuned with `--interval`.
8. **Where the Board applies.**
   - `usePendingSyncs` runs on the Board page (`BoardView`) for every connected factory, whatever factory is picked. It polls `listSyncRequests` every 2 s while a row is `queued`, `planned` or `applying`, else every 30 s, and calls `applySyncRequest` on the newest `planned` row.
   - "Applied the next time the Board opens" therefore means the next time the Board page is open.
   - The claim is the CAS move planned→applying. A second tab loses it, gets `null`, and does nothing.
   - Cost if wrong: a change set waits while the owner stays on Settings or a task page.
9. **Watcher last-seen and option problems.** The watcher writes `watcherSeenAt` and `githubProblems` for each connected factory.
   - `githubProblems` holds, in order: config problems, `Project <o/n> not found or not visible to <ghUser>`, and one `missing option "<name>" (used by <status>, …)` per missing option.
   - "Not seen" means `watcherSeenAt` is missing or older than `WATCHER_STALE_MS` = 120 s.
   - Cost if wrong: a stale warning for up to 30 s after the watcher starts.
10. **The Board settings section.**
    - The fields are: mode (`Off` / `Connected`; a stored `github-only` shows as a third, disabled-for-selection option and is kept on save), Project text, label (prefilled `factory`, empty means no filter), approvers (comma-separated, empty means `[ghUser]`), and the status map as a 13-row table prefilled from `DEFAULT_STATUS_MAP` (spec 5).
    - Validation is the core's `validateFactoryDef`.
    - The watcher's problems for the factory show above the table.
    - While the schema is missing, the section shows only the schema message, and the mode select is disabled.
    - Cost if wrong: copy and layout changes only.
11. **Card states.**
    - `#<n>` (link to `https://github.com/<repo>/issues/<n>`) when the link has an issue.
    - **waiting for GitHub** when it has none and the task is open.
    - `GitHub: <message>` when `link.error.attempts >= STUCK_ATTEMPTS` (3). That is "keeps failing": the first two failures are normal retries.
    - Nothing for factories that aren't `connected`, or for done/cancelled tasks that never got an issue.
    - Cost if wrong: an error shows a retry later or sooner.
12. **Before the owner applies the schema change.**
    - `githubSchemaReady()` probes four things once per store instance: a list of each new table, `FactoryDef.github`, and `FactoryHealth.watcherSeenAt`. Any error except `BlocksUnauthorizedError` counts as not ready.
    - A true result is cached for the life of the store. A false result is re-probed after 60 s.
    - While not ready:
      - Defs and health are read without the new fields.
      - Links and requests read as empty.
      - Saving a def with `github`, `saveGitHubLink`, `requestSync` and `saveSyncRequest` throw `ForbiddenError(GITHUB_SCHEMA_MISSING)`.
      - Health writes only its old fields.
    - Cost if wrong: during a Blocks outage the Board shows the schema message instead of a load error, for up to 60 s.
13. **Doctor.** For a `connected` factory on `--store blocks`, two more checks:
    - `github tables` (from `githubSchemaReady`).
    - `watcher`: ok `seen <iso>`; fail `not seen since <iso>; run factory sync --watch --store blocks`; fail `never seen; run factory sync --watch --store blocks`.

    Cost if wrong: doctor wording only.
14. **CLI pushes on Blocks.**
    - `pushAfter` and `pushAllAfter` now run on both stores. The pusher picks the mode that fits the store (`github-only` on file, `connected` on blocks), so `factory new` on Blocks creates the issue at once (spec 6.2).
    - `pullBefore` stays file-only, because connected mode pulls only on Sync.
    - `factory sync --rebuild --store blocks` exits 1 with `--rebuild is for GitHub-only factories (--store file)`.
    - Cost if wrong: one extra GitHub call per CLI command for connected factories.
15. **Plan size.** `fitSyncPlan` drops `create` actions from the end until the row's `plan` JSON is at most `MAX_SYNC_JSON_BYTES` (= `MAX_DOC_BYTES`). Each dropped action becomes not applied `new issue` / `too many changes for one Sync; click Sync again`. Cost if wrong: only a Project with thousands of new issues is affected.

## Global Constraints

- The browser never holds a GitHub token, and the Board never calls GitHub. `githubSync.ts` is pure (no Node API, no credential) and exported from `core/src/browser.ts`. `githubWatcher.ts` goes on the `FORBIDDEN` list in `core/test/browser.test.ts`.
- `mode: connected` only on the Blocks store, `github-only` only on the file store (spec 5). `githubConfigProblems` is called with the real store kind everywhere (no hard-coded `'file'` left in the pusher or puller).
- Pull in connected mode happens only on Sync (spec 8.1). Comments and reviews are not read in connected mode (spec 7, last bullet). The stage 3 `pullNeeds` already does this.
- Every pulled owner change goes through `applyPull` and the owner functions with version checks. `block` is applied only by the core identity (spec 8.3).
- A factory with no `github` block behaves exactly as today: no new rows, no GitHub calls, no new card UI, no Sync button.
- Exact strings:
  - `GITHUB_SCHEMA_MISSING` = `GitHub tables are missing in Blocks Data; apply the schema change in docs/setup/blocks-project-setup.md`
  - The button reads `Sync with GitHub`. While waiting it reads `Syncing… (waiting for the factory machine)`. When the watcher is stale it reads `Sync with GitHub (factory machine not seen for 2+ minutes)`.
  - The card chip reads `waiting for GitHub`.
- Error text goes through `redactSecrets` (Node) or the token rule in `githubPullApply.ts` (pure).
- The owner's shell has `FACTORY_STORE=blocks`: every core test that calls `run()` passes `--store` explicitly.
- Agents can't apply Blocks schema changes. The plan only generates the files and documents the steps. The owner applies them (final checklist).
- Ground rules: never push, never change git config or remotes, never touch `../blocks/`. Commit on the current branch only.

## Review Focus

1. **The owner clicks Sync twice, or has two tabs open,** while a new labelled issue exists. Exactly one task is created. (Task 4, `a second applier loses the claim and applies nothing`; Task 5, `pending issues are not planned again`; Task 6, `a second request while the first is unapplied supersedes it`.)
2. **The Board page closes in the middle of applying a change set.** The row doesn't block Sync forever, and the next Sync creates no duplicate task. (Task 6, `an applying row older than 120 s fails and the next request is planned`; Task 8 end to end, step 5.)
3. **The schema change isn't applied yet.** The Board still lists tasks and factories, saving a factory without GitHub works, and `factory sync --watch --store blocks` says why it does nothing. (Task 3, `before the schema is applied …`; Task 7, `sync on blocks without the schema prints the message and exits 1`; Task 9, `a missing schema shows the message and the rest of the form saves`.)
4. **Saving the factory form on the Board drops the existing `github` block.** The draft must round-trip it. (Task 9, `saving an unrelated field keeps the github block`.)
5. **The watcher isn't running when the owner clicks Sync.** The button says so, still queues the request, and the change set is applied when the watcher catches up, even after a page reload. (Task 11, `stale watcher label still queues`, `a planned row is applied on mount`.)

---

### Task 1: Blocks schema, generated resources, setup doc

**Files:**
- Modify: `core/src/blocks/schema.ts`, `docs/setup/blocks-project-setup.md`
- Regenerate: `blocks/data/factory/*.fields.json`, `blocks/data/factory/indexes.json`, `blocks/data/rules.json` (with `cd core && npm run -s blocks:resources`)
- Test: `core/test/blocks/schema.test.ts`

**Interfaces:**
- Produces in `schema.ts`:
  - `TABLES` += `'FactoryGitHubLink'`, `'FactorySyncRequest'` (12 tables).
  - `FIELDS.FactoryGitHubLink` = `taskId`, `factoryId`, `json` (String), `version` (Int), `writeId`.
  - `FIELDS.FactorySyncRequest` = `requestId`, `factoryId`, `requestedAt`, `requestedBy`, `state`, `plan`, `plannedAt`, `applyingSince`, `result`, `appliedAt`, `error` (String), `version` (Int), `writeId`. Each field gets a one-line description in the file's style.
  - `FIELDS.FactoryDef` += `s('github', 'JSON text of the GitHub settings; empty = no GitHub.')`. `FIELDS.FactoryHealth` += `s('watcherSeenAt', …)`, `s('githubProblems', 'JSON text of the GitHub setup problems the watcher found.')`.
  - `UNIQUE`: `FactoryGitHubLink: ['taskId']`, `FactorySyncRequest: ['requestId']`.
  - `ACCESS`: `FactoryGitHubLink: { read: both, insert: ['factory-core'], edit: ['factory-core'] }`, `FactorySyncRequest: { read: both, insert: ['factory-owner'], edit: both }`.
  - `export const GITHUB_SCHEMA = { tables: ['FactoryGitHubLink', 'FactorySyncRequest'], fields: { FactoryDef: ['github'], FactoryHealth: ['watcherSeenAt', 'githubProblems'] } } as const;` (Task 3 probes it.)
- Doc: a new section `## 8. GitHub connected mode (stage 4)` in `blocks-project-setup.md` gives the commands in the file's existing style:
  1. `npm run -s blocks:resources -- --check`.
  2. Create the two schemas with their fields and the unique indexes `factory_githublink_taskid_unique` and `factory_syncrequest_requestid_unique`.
  3. Save `FactoryDef.fields.json` and `FactoryHealth.fields.json` again (adds the columns).
  4. Run the step 4 rules commands, then `blocks data schema aggregation --schema-name FactoryGitHubLink`.
  5. Then `factory doctor --store blocks`.

  It also updates the table count in section 3 to 12, and adds one sentence: until this is applied, connected mode is off and the Board shows the schema message.

- [ ] **Step 1: Write the failing tests** in `schema.test.ts`:
  - `GitHub link rows are core-written, sync requests owner-inserted and edited by both`: assert both `ACCESS` entries.
  - `FactoryDef has the github column; FactoryHealth has watcherSeenAt and githubProblems`.
  - `the new tables have their unique indexes`: `generateIndexes()` contains `{ schemaName: 'FactoryGitHubLink', fields: ['taskId'], name: 'factory_githublink_taskid_unique' }` and the sync request one.
  - `GITHUB_SCHEMA names only existing tables and fields`.
  - Update `ACCESS equals the matrix` for the 12 tables.
- [ ] **Step 2: Run** `cd core && npx vitest run test/blocks/schema.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the schema entries, then run `npm run -s blocks:resources` to regenerate the files, then write the doc section.
- [ ] **Step 4: Run** `npx vitest run test/blocks && npm run -s blocks:resources -- --check && npm run typecheck`. Expected: PASS, and the check reports the files current.
- [ ] **Step 5: Commit** `git add core/src/blocks/schema.ts core/test/blocks/schema.test.ts blocks/data docs/setup/blocks-project-setup.md && git commit -m "Blocks schema for GitHub links and sync requests"`

### Task 2: Sync request model; store methods on Memory and File stores

**Files:**
- Create: `core/src/githubSync.ts` (types and pure helpers; `applySyncRequest` comes in Task 4)
- Modify: `core/src/boardStore.ts`, `core/src/store.ts`, `core/src/factories.ts` (`FactoryHealth`), `core/src/githubConfig.ts` (`DEFAULT_STATUS_MAP`), `core/src/wire.ts` (`LazyBlocksStore` forwarders), `core/src/browser.ts`
- Test: `core/test/githubSync.test.ts`, `core/test/storeContract.ts`, `core/test/blocks/store.test.ts` (contract opts only)

**Interfaces:**
- Produces in `githubSync.ts`:
  ```ts
  export type SyncState = 'queued' | 'planned' | 'applying' | 'applied' | 'failed';
  export interface SyncDone { taskId: string; issue: string; change: string }
  export interface SyncPlan { actions: PullAction[]; notApplied: NotApplied[]; done: SyncDone[]; errors: PullError[] }
  export interface SyncResult { created: { taskId: string; issue: string; status: 'inbox' | 'ready' }[]; applied: SyncDone[]; notApplied: NotApplied[]; errors: PullError[] }
  export interface SyncRequest {
    requestId: string; factoryId: string; requestedAt: string; requestedBy: string; state: SyncState;
    plan: SyncPlan | null; plannedAt: string | null; applyingSince: string | null;
    result: SyncResult | null; appliedAt: string | null; error: string | null; version: number;
  }
  export const SYNC_MOVES: Readonly<Record<'core' | 'owner', readonly (readonly [SyncState, SyncState])[]>>;  // builder's call 4
  export const canSyncMove: (from: SyncState, to: SyncState, who: 'core' | 'owner') => boolean;
  export const SYNC_APPLY_MS = 120_000;
  export const WATCHER_STALE_MS = 120_000;
  export const MAX_SYNC_JSON_BYTES = MAX_DOC_BYTES;
  export const GITHUB_SCHEMA_MISSING = 'GitHub tables are missing in Blocks Data; apply the schema change in docs/setup/blocks-project-setup.md';
  export function fitSyncPlan(p: SyncPlan): SyncPlan;                                        // builder's call 15
  export function latestSync(rows: SyncRequest[], state?: SyncState): SyncRequest | undefined; // newest by requestedAt, then requestId
  export function watcherState(h: FactoryHealth | undefined, now: Date): 'seen' | 'stale' | 'never';
  export const syncSummary = (r: SyncResult): string => `created ${r.created.length}, applied ${r.applied.length}, not applied ${r.notApplied.length}, failed ${r.errors.length}`;
  ```
- `FactoryHealth` gains `watcherSeenAt?: string | null; githubProblems?: string[]`.
- `githubConfig.ts`: `export const DEFAULT_STATUS_MAP: Record<Status, string>` is the spec 5 map, exported from `browser.ts`.
- `BoardStore` gains:
  ```ts
  /** False while the Blocks schema change is not applied (always true on Memory and File stores). */
  githubSchemaReady(): Promise<boolean>;
  /** One factory's sync requests, or all, by requestedAt ascending. */
  listSyncRequests(factoryId?: string): Promise<SyncRequest[]>;
  /** Owner only. A new `queued` row with a random requestId and requestedAt = now. */
  requestSync(factoryId: string, requestedBy: string): Promise<SyncRequest>;
  /** CAS on version; after.state must differ from before.state and canSyncMove for the store's identity, else ForbiddenError. */
  saveSyncRequest(before: SyncRequest, after: SyncRequest): Promise<SyncRequest>;
  ```
- `MemoryStore.setFactoryHealth` merges the fields: `watcherSeenAt`/`githubProblems` overwrite only when they are present (builder's call 3). `MemoryStore` state gains `syncRequests: SyncRequest[]`. The `FileStore` persists it, and a missing key loads as `[]`.

- [ ] **Step 1: Write the failing tests.**
  - `githubSync.test.ts`:
    - `core may plan or fail a queued row; only the owner claims and finishes`: check every pair against `canSyncMove`.
    - `fitSyncPlan keeps a small plan as is and drops the last creates of a large one`: 3 creates whose descriptions are 2 MiB each give 1 create, plus 2 not applied with reason `too many changes for one Sync; click Sync again`.
    - `latestSync picks the newest, optionally by state`.
    - `watcherState is never without a time, stale after 120 s, else seen`.
    - `syncSummary counts each list`.
  - `storeContract.ts`, a new `describe('sync requests')`:
    - `the owner requests, the core plans, the owner claims and finishes`. Walk queued→planned→applying→applied and assert the versions 1..4.
    - `a stale before is a VersionConflictError`.
    - `the core may not request; the owner may not plan; the same state twice is forbidden` (`ForbiddenError`).
    - `githubSchemaReady is true`. (Task 3 overrides this for the Blocks fake with a missing schema.)
    - `health keeps watcher fields when status writes without them`.
- [ ] **Step 2: Run** `npx vitest run test/githubSync.test.ts test/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `githubSync.ts` and the Memory/File store methods. Add the `LazyBlocksStore` forwarders and the `browser.ts` exports.
  - `runStoreContract` gains a third parameter `opts: { github?: boolean } = {}`. With `github: false`, it skips the `sync requests` block.
  - `core/test/blocks/store.test.ts` passes `{ github: false }` until Task 3 removes it.
  - For now, `BlocksStore` gets stubs that throw `ForbiddenError(GITHUB_SCHEMA_MISSING)` and return `false` from `githubSchemaReady`, so the whole suite stays green.
- [ ] **Step 4: Run** `npx vitest run test/githubSync.test.ts test/store.test.ts test/browser.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add core/src/githubSync.ts core/test/githubSync.test.ts && git commit -am "Sync request model and store methods"`

### Task 3: BlocksStore: links, sync requests, github column, health fields, schema probe

**Files:**
- Modify: `core/src/blocks/store.ts`, `core/src/blocks/fakeData.ts`, `core/test/blocks/store.test.ts` (contract opts), `board-ui/src/test/factories.ts` (`seedBlocksFactories` writes `github` as JSON text when the def has it)
- Test: `core/test/blocks/store.test.ts`, `core/test/blocks/fakeData.test.ts`

**Interfaces:**
- `FakeBlocksData` constructor option `missing?: { tables?: SchemaName[]; fields?: Partial<Record<SchemaName, string[]>> }`. A `list`, `insert` or `update` on a missing table, or one that names a missing field (in `fields`, the filter, or the row), throws `new Error('blocks: <operationName> GraphQL error')`, as the live gateway does for an unknown name.
- `BlocksStore`:
  - `githubSchemaReady()` follows builder's call 12. The probe is `list(<table>, { <unique>: '-' }, [<unique>])` for each `GITHUB_SCHEMA` table, and `list(<table>, { <unique>: '-' }, [<field>])` for each field.
  - `listFactoryDefs`/`listFactoryHealth` pass an explicit field list without the new columns while not ready.
  - `decodeDef`: `github` `''`/null means absent. Otherwise `JSON.parse`. Malformed JSON decodes to the raw text, so `validateFactoryDef` refuses the factory with a reason (the `agentModels` pattern).
  - `encodeDef`: when ready, always writes `github: d.github ? JSON.stringify(d.github) : ''`. When not ready, writes nothing for it, and throws `ForbiddenError(GITHUB_SCHEMA_MISSING)` if `after.github` is set.
  - Links: `listGitHubLinks(factoryId?)`, `getGitHubLink(taskId)` and `saveGitHubLink(before, after)` through `insertVersioned`/`updateVersioned` on `FactoryGitHubLink`, keyed by `taskId`. Saving is core only (`ForbiddenError('GitHub links are written by the factory core')` for the owner). Reads go through `withLinkDefaults`.
  - Sync requests: the `BoardStore` methods from Task 2. `plan` and `result` are JSON text, and nullable texts are stored as `''` and read as null (add the table to `CLEARABLE_FIELDS`). `requestSync` is owner only (`OwnerOnlyError`).
  - Health: `setFactoryHealth` adds `watcherSeenAt`/`githubProblems` to its write only when they are present and the schema is ready. `decodeHealth` reads them when they are selected.

- [ ] **Step 1: Write the failing tests** in `blocks/store.test.ts`:
  - `stores a link as JSON in its own row; the owner reads it but may not save it`.
  - `a sync request round-trips plan and result JSON; nullable texts read back as null`.
  - `the github block is stored as JSON text and read back; turning it off writes empty text`.
  - `health keeps watcher fields when written without them`.
  - `under the access rules the core writes links and plans requests; the owner requests and applies`. Use two `FakeBlocksData` roles on one `newFakeStorage()`.
  - `before the schema is applied defs, tasks and health still load; links and requests are empty`. Use `missing: GITHUB_SCHEMA`: `listFactoryDefs` returns the def without `github`, `listGitHubLinks()` is `[]`, and `githubSchemaReady()` is false.
  - `before the schema is applied a def without github saves; with github, a link save, requestSync are refused with the schema message`.
  - `the probe result true is kept; false is probed again after 60 s` (inject `now`).
  - `fakeData.test.ts`: `a missing table or field fails like an unknown GraphQL name`.
- [ ] **Step 2: Run** `npx vitest run test/blocks`. Expected: FAIL.
- [ ] **Step 3: Implement** the above, and remove the `{ github: false }` from the Blocks `runStoreContract` call.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`, then `cd ../board-ui && npx vitest run && npm run lint`. Expected: PASS. The Blocks contract suite is green.
- [ ] **Step 5: Commit** `git commit -am "Store GitHub links, sync requests and the github block in Blocks Data, gracefully before the schema exists"`

### Task 4: `applySyncRequest` (pure, used by the Board)

**Files:**
- Modify: `core/src/githubSync.ts`
- Test: `core/test/githubSync.test.ts`

**Interfaces:**
- Consumes: `applyPull`, `ApplyResult` (stage 3); `SyncRequest`, `canSyncMove`, `SYNC_APPLY_MS` (Task 2).
- Produces:
  ```ts
  /** Claims the planned row (planned→applying), applies its actions as the caller (the owner), stores the result (applied). Null when another applier holds it. */
  export function applySyncRequest(store: BoardStore, now: () => Date, row: SyncRequest): Promise<SyncRequest | null>;
  /** An applying row whose claim is older than SYNC_APPLY_MS: applying→failed with `interrupted while applying; click Sync again`. Null when it is not stale or the save conflicts. */
  export function failStaleSync(store: BoardStore, now: () => Date, row: SyncRequest): Promise<SyncRequest | null>;
  export function toSyncResult(plan: SyncPlan, r: ApplyResult): SyncResult;
  ```
- Behaviour:
  - `row.state !== 'planned'` returns null.
  - Claim: save `{ state: 'applying', applyingSince: now }`. A `VersionConflictError` returns null.
  - The `block` actions are pulled out before calling `applyPull`, and each one becomes not applied `the factory machine applies this`.
  - `toSyncResult` puts `plan.done` before the applied actions, and `plan.errors` before the apply errors. It drops `action` and `onApplied`, and strips `link` from not-applied items.
  - Finish: save `{ state: 'applied', result, appliedAt: now }`. If `applyPull` throws (it shouldn't), save `{ state: 'failed', error: firstLine }` and rethrow.

- [ ] **Step 1: Write the failing tests** (MemoryStore with identity `owner`; the rows are seeded through a core-identity store on the same state, or by `saveSyncRequest` with a test helper):
  - `a planned row with create and ready is applied and stored as applied with a summary`. The task exists with a `github` create event, and `syncSummary(result)` = `created 1, applied 1, not applied 0, failed 0`.
  - `done and errors from the factory machine lead the result`.
  - `a block action is not applied by the Board`.
  - `a stale version is listed as not applied, not as an error`.
  - `a second applier loses the claim and applies nothing`. Run two `applySyncRequest` calls on the same `row`: one returns null, and only one task exists.
  - `a non-planned row is ignored`.
  - `failStaleSync fails an applying row after 120 s and leaves a fresh one`.
- [ ] **Step 2: Run** `npx vitest run test/githubSync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/githubSync.test.ts test/browser.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Board-side applier for a planned sync request"`

### Task 5: Pusher and planner for connected factories

**Files:**
- Modify: `core/src/githubPusher.ts`, `core/src/githubPull.ts`, `core/src/githubPuller.ts`
- Test: `core/test/githubPusher.test.ts`, `core/test/githubPull.test.ts`, `core/test/githubPuller.test.ts`

**Interfaces:**
- `githubPull.ts`:
  - `export function createdFromIssue(events: FactoryEvent[]): IssueRef | null`. It finds the `create` event with actor `github` and reason matching `/^created from GitHub issue ([^\s#]+\/[^\s#]+)#(\d+)$/`.
  - `PullInput.pendingIssues?: string[]` holds issue names. `planPull` skips an unlinked item whose `issueName` matches one, case-insensitive.
- `githubPusher.ts`:
  - `PusherDeps.storeKind?: 'file' | 'blocks'` (default `'file'`). The mode that is pushed is `storeKind === 'file' ? 'github-only' : 'connected'`, in `push` and in `pushAll`. `githubConfigProblems(…, storeKind)`.
  - `PushResult.skipped` gains `'waiting'`.
  - For a connected task with no link, `listEvents(taskId)` is read once:
    - No events at all: return `skipped: 'waiting'`, and write nothing.
    - `createdFromIssue` gives a ref: the `create` action adopts the Project item with that repo and number (from the cached `listItems`). It saves `issueNumber`, `issueNodeId`, `itemId`, `project`, and `pushed.title` = the issue title, `bodyHash: null`, `label` as in the existing adopt. The phrase is `adopted`.
    - If that item isn't on the Project, it fails with `issue <o/r#n> is not on the Project`.
- `githubPuller.ts`: extract
  ```ts
  /** Reads the Project and builds the plan for one factory. plan null when the Project could not be read (errors say why). */
  planFactory(def: FactoryDef, defs: FactoryDef[], repos: FactoryRepo[], storeKind: 'file' | 'blocks', extra?: { pendingIssues?: string[] }): Promise<{ plan: PullPlan | null; errors: PullError[] }>;
  /** Saves NotApplied link patches (option, report) only; used by the watcher. */
  saveNotAppliedLinks(def: FactoryDef, notApplied: NotApplied[]): Promise<PullError[]>;
  ```
  `pullFactory` uses `planFactory` with `'file'`, and its behaviour doesn't change.

- [ ] **Step 1: Write the failing tests.**
  - `githubPull.test.ts`:
    - `createdFromIssue reads the github create event; a Board create gives null`.
    - `pending issues are not planned again`: an unlinked labelled Todo item in `pendingIssues` gives no `create`.
  - `githubPusher.test.ts`:
    - `a connected task on the blocks kind gets an issue; on the file kind it is not-github`.
    - `a github-only factory on the blocks kind is not pushed`.
    - `a task created from a GitHub issue adopts it, writes the marker, and creates no issue`: the fake has issue `o/app#4` on the project, and the task was made with `createTaskFromGitHub(…, 'o/app#4')`. Afterwards `board.issues` has one issue, the link has `issueNumber: 4`, and its body ends with the marker.
    - `a task with no events yet waits`: `skipped: 'waiting'`, and no link is written.
    - `a Board task with a create event by you is created as usual`.
  - `githubPuller.test.ts`: `planFactory returns the plan without applying it`. The store is unchanged and `plan.actions[0].kind` is `create`.
- [ ] **Step 2: Run** `npx vitest run test/githubPull.test.ts test/githubPusher.test.ts test/githubPuller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Push connected factories; adopt issues of tasks created from GitHub"`

### Task 6: Watcher

**Files:**
- Create: `core/src/githubWatcher.ts`
- Modify: `core/test/browser.test.ts` (`FORBIDDEN` += `githubWatcher`)
- Test: `core/test/githubWatcher.test.ts`

**Interfaces:**
- Consumes: `GitHubPusher` (`storeKind: 'blocks'`), `GitHubPuller.planFactory`/`saveNotAppliedLinks` (Task 5), `applyPull` (core identity, for `block` actions), `createdFromIssue`, `fitSyncPlan`, `failStaleSync`, `canSyncMove`, `SYNC_APPLY_MS` (Tasks 2 and 4), `githubConfigProblems`, `GitHubBoard.project`, `redactSecrets`.
- Produces:
  ```ts
  export const WATCHER_HEALTH_MS = 30_000;
  export interface WatcherDeps {
    store: BoardStore; boardFor: GitHubBoardFor; githubFor: GitHubFor; now: () => Date; claimant: string;
    lock?: PullLock; loggedIn: () => Promise<ReadonlySet<string>>;
  }
  export interface SyncHandled { factoryId: string; requestId: string; state: 'planned' | 'failed'; actions: number; notApplied: number; error: string | null }
  export interface WatchTick { schemaMissing: boolean; pushed: PushResult[]; synced: SyncHandled[]; superseded: string[] }
  export function optionProblems(settings: GitHubSettings, info: ProjectInfo | null, ghUser: string): string[];  // builder's call 9
  export class GitHubWatcher {
    constructor(d: WatcherDeps);
    tick(factoryIds?: string[]): Promise<WatchTick>;   // builder's call 7; never throws for a GitHub error
  }
  ```
- Per connected factory, the request step:
  1. List its requests.
  2. Run `failStaleSync` on each stale `applying` row (the core may: applying→failed). If a fresh `applying` row remains, stop for this factory.
  3. Fail older `queued` rows, and every `planned` row older than the newest `queued` one, with `superseded by a newer Sync`. Their ids go to `superseded`.
  4. For the newest `queued` row, take the lock. If it is held, leave the row queued for the next tick.
  5. Build `pendingIssues` from the unlinked tasks of the factory: `createdFromIssue(await listEvents(id))`.
  6. Call `planFactory(…, 'blocks', { pendingIssues })`. If `plan` is null, save the row as `failed` with the first error's message.
  7. Apply the `block` actions through `applyPull(store, now, { factoryId, actions: blocks, notApplied: [] })` with the core store. Their `applied`/`errors` become `done`/`errors`.
  8. Call `saveNotAppliedLinks`. Its errors join `errors`.
  9. Save `{ state: 'planned', plan: fitSyncPlan({ actions: rest, notApplied, done, errors }), plannedAt: now }`. A `VersionConflictError` (another watcher planned it) is ignored.
- Health step: when the schema is ready and `WATCHER_HEALTH_MS` has passed since this instance last wrote it, for each connected factory, `setFactoryHealth({ factoryId, ghLoggedIn: isGhLoggedIn(await loggedIn(), def.ghUser), checkedAt: now, watcherSeenAt: now, githubProblems })`. `githubProblems` comes from the config problems plus `optionProblems(settings, await board.project(ref), ghUser)`. A read error becomes a problem with its first line.

- [ ] **Step 1: Write the failing tests** in `githubWatcher.test.ts`. Use a `BlocksStore('core')` and a `BlocksStore('owner')` on two `FakeBlocksData` roles that share one storage, a connected factory `f` (remote `git@github.com:o/app.git`, project `o/3`, the spec 5 map), a `FakeGitHubBoard` and a `FakeGitHub`:
  - `a Board-created task gets an issue on the next tick`.
  - `a queued request becomes a planned change set; the owner applies it`. A labelled `Todo` issue gives a plan with one `create`. Then `applySyncRequest` as the owner gives a ready task. The next tick adopts the issue (`link.issueNumber`) and writes the marker.
  - `label removed on a build task is blocked by the factory machine and listed as done`. The task is `blocked` with reason `label removed`, and `plan.done[0].change` = `blocked (label removed)`.
  - `a Status move not applied saves the option, so the push puts it back`.
  - `a second request while the first is unapplied supersedes it`.
  - `an applying row older than 120 s fails and the next request is planned`.
  - `a missing Project fails the request with its message`.
  - `health: watcherSeenAt, ghLoggedIn and a missing option are written; not again within 30 s`. The map uses `Testing` for `verify`, and the fake has no such option, so the problem is `missing option "Testing" (used by verify)`.
  - `without the schema the tick does nothing and reports schemaMissing`. Use the fake with `missing: GITHUB_SCHEMA`; no board calls are made.
  - `a factory without github is untouched`.
- [ ] **Step 2: Run** `npx vitest run test/githubWatcher.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `githubWatcher.ts` and the `FORBIDDEN` entry.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add core/src/githubWatcher.ts core/test/githubWatcher.test.ts && git commit -am "Watcher: push connected factories, plan sync requests, write health"`

### Task 7: CLI and doctor on the Blocks store

**Files:**
- Modify: `core/src/cli.ts`, `core/src/doctor.ts`, `plugin/README.md` (the `factory sync` line names `--store blocks` for connected mode)
- Test: `core/test/cli.test.ts`, `core/test/doctor.test.ts`

**Interfaces:**
- Consumes: `GitHubWatcher`, `WatchTick` (Task 6); `githubSchemaReady`, `listFactoryHealth`; `GITHUB_SCHEMA_MISSING`, `watcherState`.
- `CliDeps.loggedIn?: () => Promise<ReadonlySet<string>>` (default `() => ghLoggedInUsers(exec)`).
- `pusherFor(store, storeKind)`: `pushAfter`/`pushAllAfter` run on both stores (builder's call 14). On Blocks, each one first returns quietly when `githubSchemaReady()` is false.
- `factory sync --store blocks`:
  - `--rebuild` exits 1 with `--rebuild is for GitHub-only factories (--store file)`.
  - Once: one `tick`.
    - `schemaMissing` prints `GITHUB_SCHEMA_MISSING` and exits 1.
    - No connected factory prints `no factory uses connected mode`.
    - Otherwise, per synced request: `sync <f> <first 8 of requestId>: planned <actions> changes, <notApplied> not applied` or `sync <f> <id8>: FAIL <error>`. Per superseded request: `sync <id8>: superseded`.
    - Then the push lines as today, and `pushed <n>, failed <m>`.
    - Exit 1 when a request failed or a push failed.
  - `--watch`: the same lines each tick, the schema message only once per process, no summary.
- `factory status` lists push errors for `connected` factories on the Blocks store, as well as for `github-only` ones on the file store.
- `doctor({ …, schemaReady?: boolean; health?: FactoryHealth[]; now?: Date })` gains the two checks of builder's call 13, only for `connected` factories when `store === 'blocks'`. `github tables` comes right after `config`, and `watcher` comes after the label checks. The CLI passes `await store.githubSchemaReady()` and `await store.listFactoryHealth()`.

- [ ] **Step 1: Write the failing tests.**
  - `cli.test.ts` (Blocks store via `makeEngine` returning a core `BlocksStore` over a shared `FakeBlocksData` storage, `--store blocks` explicit):
    - `sync on blocks without the schema prints the message and exits 1`.
    - `sync on blocks plans a queued request and pushes`. The owner store calls `requestSync('f', 'me')`, and stdout has `sync f ` … `: planned 1 changes, 0 not applied`.
    - `sync --watch on blocks prints the schema message once across ticks` (`watchTicks: 2`).
    - `sync --rebuild on blocks is refused`.
    - `new on blocks for a connected factory pushes at once`: the fake board has one issue after `factory new`.
    - `status on blocks shows a stuck connected push`.
  - `doctor.test.ts`:
    - `connected on blocks: github tables and watcher seen`.
    - `missing schema and a stale watcher fail with their hints`.
    - `github-only on file: no new checks`.
- [ ] **Step 2: Run** `npx vitest run test/cli.test.ts test/doctor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the CLI changes, the doctor checks and the README line.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck`, then `cd ../plugin && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "factory sync and doctor for connected mode on the Blocks store"`

### Task 8: Connected mode end to end (core)

**Files:**
- Test: `core/test/integration.test.ts` (new `describe('connected mode end to end')`)
- Modify: `docs/superpowers/specs/2026-11-13-github-board-integration-design.md`. Under 9.2, add one line: "Stage 4 build: sync request rows, watcher and Board applier, see the stage 4 plan's builder's calls."

**Interfaces:**
- Consumes: everything above, through `run()` with `--store blocks`, plus `applySyncRequest` with an owner `BlocksStore` on the same fake storage, `FakeGitHubBoard`, and an in-memory `pullLock`.

- [ ] **Step 1: Write the test** `a Board task and a GitHub issue round-trip through the watcher and Sync`:
  1. Seed connected factory `f` (via the owner `saveFactory`, with `github` set) and repo `app`. Create task T-1 as the owner (`createTask`). Run `sync`: issue `o/app#1` exists with the marker, and its Status is `Backlog`.
  2. In the fake, create issue `o/app#2` with label `factory` in `Todo`, and move `o/app#1` from `Backlog` to `Todo`. Run `requestSync`, then `sync`: the row is `planned` with one `create` and one `ready`.
  3. Run `applySyncRequest` as the owner: T-2 exists and is `ready`, and T-1 is `ready`. The row is `applied`, with summary `created 1, applied 1, not applied 0, failed 0`.
  4. Run `sync`: `o/app#2` now ends with `<!-- tsf:task=T-2 factory=f -->` and no third issue exists.
  5. Interrupted apply: queue a request with a new labelled issue `o/app#3`, run `sync` (planned), then claim it as the owner and stop (save `applying` by hand). Advance `now` by 121 s, then `requestSync` and `sync`: the old row is `failed` and the new one is planned. Apply it. Exactly one task points at `o/app#3`, through `createdFromIssue`.
  6. Remove the label from `o/app#1` after the core moves T-1 to `build`. Request, sync and apply: T-1 is `blocked` (`label removed`), and the result's `applied` lists `blocked (label removed)` first.
- [ ] **Step 2: Run** `npx vitest run test/integration.test.ts`. Expected: PASS. If it fails, fix the owning task's code, not the test's expectations.
- [ ] **Step 3: Run the full suite** `npx vitest run && npm run typecheck`. Expected: all PASS.
- [ ] **Step 4: Commit** `git commit -am "Test connected mode end to end on the Blocks fake"`

### Task 9: Board: GitHub section in factory settings; watcher last-seen

**Files:**
- Create: `board-ui/src/features/settings/GitHubSection.tsx`, `board-ui/src/features/github/useGitHub.ts`
- Modify: `board-ui/src/features/settings/factoryDraft.ts`, `board-ui/src/features/settings/FactoryForm.tsx`, `board-ui/src/features/settings/FactoriesTab.tsx`, `board-ui/src/app/board.css` (section and table styles in the file's tokens)
- Test: `board-ui/src/features/settings/factoryDraft.test.ts`, `board-ui/src/features/settings/GitHubSection.test.tsx`, `board-ui/src/features/settings/FactoriesTab.test.tsx`

**Interfaces:**
- Consumes: `DEFAULT_STATUS_MAP`, `DEFAULT_LABEL`, `GITHUB_SCHEMA_MISSING`, `watcherState`, `validateFactoryDef`, and `FactoryHealth` with `watcherSeenAt`/`githubProblems` (core, through `@factory/core`).
- `useGitHub.ts`:
  - `GITHUB_SCHEMA_KEY` and `useGitHubSchema()`: `boardStore.githubSchemaReady()`, staleTime 60 s.
  - `GITHUB_LINKS_KEY` and `useGitHubLinks(enabled: boolean)`: `listGitHubLinks()`, every 30 s.
  - `syncKey(f)` and `useSyncRequests(factoryId: string | null)`: polls every 2 s while the latest row is `queued`/`planned`/`applying`, else every 30 s.
- `factoryDraft.ts`:
  ```ts
  export type GitHubDraft = { mode: 'off' | 'connected' | 'github-only'; project: string; label: string; approvers: string; statusMap: Record<Status, string> };
  // Draft gains `github: GitHubDraft`
  export const githubDraftOf = (g: GitHubSettings | undefined): GitHubDraft;  // off → project '', label DEFAULT_LABEL, approvers '', statusMap DEFAULT_STATUS_MAP
  ```
  `toFactoryInput` sets `github`:
  - `undefined` for `off`.
  - Otherwise `{ mode, project: project.trim(), label, statusMap }`, plus `approvers: list` only when the comma/space split is non-empty.
- `GitHubSection({ draft, onChange, health, schemaReady })` renders a `<fieldset>` with legend `GitHub`:
  - The `GitHub mode` select. The `github-only` option is present only when the stored mode is `github-only`.
  - When the mode is not off: `Project`, `Label`, `Approvers` and the `Status map` table (one row per `ALL_STATUSES` in order, each with an input labelled `<status> option`).
  - Above the table: `health.githubProblems` as a list under `The factory machine reports:`. With no `watcherSeenAt`, the hint `The factory machine checks these names when factory sync --watch --store blocks runs.`
  - With `schemaReady === false`: only `GITHUB_SCHEMA_MISSING`, and the select is disabled.
  - Hints use builder's call 10 copy.
- `FactoriesTab`: for a connected factory, a chip after `GhStatus`. It reads `watcher seen <formatTime>` when `watcherState` is `seen`, `watcher not seen since <formatTime>` when `stale`, and `watcher not running` when `never`.

- [ ] **Step 1: Write the failing tests.**
  - `factoryDraft.test.ts`:
    - `saving an unrelated field keeps the github block`: `toFactoryInput(draftOf(def with github), def).github` deep-equals the stored `github` (project as `{owner, number}` passes `validateFactoryDef`).
    - `off drops github; connected with blank approvers leaves them to the default`.
  - `GitHubSection.test.tsx` (inside `FactoryForm`, with the fake board):
    - `turning connected on shows the prefilled status map and saves a valid def`: pick Connected, type `o/3`, save, and the stored def has `github.mode` `connected` and `statusMap.done` `Merged`.
    - `an invalid map shows the core's message`: set `ready` to `Backlog`, and `github.statusMap: inbox and ready must map to different options` is in an alert.
    - `the watcher's problems show above the table`.
    - `a missing schema shows the message and the rest of the form saves`: spy `githubSchemaReady` → false, change the name, and save.
  - `FactoriesTab.test.tsx`: `a connected factory shows watcher seen, not seen since, or not running`.
- [ ] **Step 2: Run** `cd board-ui && npx vitest run src/features/settings`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npm run lint`. Expected: PASS (including the phone-width and control audit tests).
- [ ] **Step 5: Commit** `git add board-ui/src && git commit -m "Board: GitHub settings section and watcher last-seen"`

### Task 10: Board: card states

**Files:**
- Create: `board-ui/src/features/github/githubCard.ts`
- Modify: `board-ui/src/features/board/TaskCard.tsx`, `board-ui/src/features/board/BoardView.tsx`, `board-ui/src/app/board.css`
- Test: `board-ui/src/features/github/githubCard.test.ts`, `board-ui/src/features/board/TaskCard.test.tsx`, `board-ui/src/features/board/BoardView.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export const STUCK_ATTEMPTS = 3;
  export interface CardGitHub { issue: { label: string; url: string; name: string } | null; waiting: boolean; error: string | null }
  export const issueUrl = (repo: string, n: number): string => `https://github.com/${repo}/issues/${n}`;
  export function cardGitHub(task: Task, link: GitHubLink | undefined, def: FactoryDef | undefined): CardGitHub | null;  // builder's call 11
  ```
- `TaskCard` gains a `github?: CardGitHub | null` prop, rendered in `.sf-card-meta`:
  - The issue is an `<a>` with text `#<n>`, `aria-label="GitHub issue <name>"`, `target="_blank"` and `rel="noreferrer"`. It sits above the covering title link (z-index, as the CTA does).
  - `waiting` renders the chip `waiting for GitHub`.
  - `error` renders `<p className="sf-card-github-error">GitHub: <message></p>`.
- `BoardView` calls `useGitHubLinks(anyConnected)` and passes `cardGitHub(task, linkOf(task), defOf(task))` to each card.

- [ ] **Step 1: Write the failing tests.**
  - `githubCard.test.ts`:
    - `connected with an issue gives #n and the URL`.
    - `connected without a link is waiting; a done task without a link is nothing`.
    - `two failures are not stuck; three show the error, with the issue kept`.
    - `a factory without github or github-only gives null`.
  - `TaskCard.test.tsx`: `renders_the_issue_link_waiting_chip_and_stuck_error`; `the_issue_link_opens_github_not_the_task`.
  - `BoardView.test.tsx`: `cards_of_a_connected_factory_show_their_github_state`. Seed a connected factory and a link via the core store.
- [ ] **Step 2: Run** `npx vitest run src/features/github src/features/board`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `git add board-ui/src && git commit -m "Board: GitHub link, waiting and stuck states on cards"`

### Task 11: Board: Sync button, pending change sets, result panel

**Files:**
- Create: `board-ui/src/features/github/SyncButton.tsx`, `board-ui/src/features/github/usePendingSyncs.ts`
- Modify: `board-ui/src/features/board/BoardView.tsx`, `board-ui/src/app/board.css`
- Test: `board-ui/src/features/github/SyncButton.test.tsx`, `board-ui/src/features/github/usePendingSyncs.test.tsx`

**Interfaces:**
- Consumes: `applySyncRequest`, `latestSync`, `syncSummary`, `watcherState`, `GITHUB_SCHEMA_MISSING` (core); `useSyncRequests`, `useGitHubSchema` (Task 9); `useFactoryHealth`; `useCurrentUser`; `useInvalidateAfterWrite` (invalidate `BOARD_KEY` and `GITHUB_LINKS_KEY` after an apply).
- `usePendingSyncs(factoryIds: string[])` runs one `useSyncRequests` per id. When `latestSync(rows)` is `planned`, it calls `applySyncRequest(boardStore, now, row)` once per `requestId` (a ref set), then invalidates. It returns `Map<factoryId, SyncRequest>` of the newest rows.
- `SyncButton({ factoryId, latest })`, shown by `BoardView` only when the picked factory's `github.mode === 'connected'`:
  - Click: `boardStore.requestSync(factoryId, user || 'owner')`, then refetch the sync key.
  - Label:
    - `Syncing… (waiting for the factory machine)` while the latest row is `queued`, or `planned` before the apply.
    - `Syncing… (applying changes)` while it is `applying`.
    - Else `Sync with GitHub (factory machine not seen for 2+ minutes)` when `watcherState` isn't `seen`.
    - Else `Sync with GitHub`.
  - It is disabled while syncing, or when the schema is missing (the message shows beside it).
  - The result panel (`role="status"`) appears after `applied`:
    - Heading `GitHub sync: <syncSummary>`.
    - Lines: `<taskId> created from <issue> (<status>)`, `<taskId> <issue>: <change>`, `Not applied <taskId|-> <issue>: <change> (<reason>)`, `Failed <taskId|-> <issue|->: <message>`.
    - A `Dismiss` button.
  - A `failed` row shows `Sync failed: <error>`. Results already dismissed (by `requestId`, in memory) don't show again.

- [ ] **Step 1: Write the failing tests** (fake board; the core store plays the watcher by saving `planned` rows):
  - `SyncButton.test.tsx`:
    - `only_a_connected_factory_shows_the_button` (BoardView).
    - `click_queues_a_request_and_shows_waiting`: one row `queued`, with `requestedBy` the user.
    - `stale_watcher_label_still_queues`: health with `watcherSeenAt` 3 minutes old.
    - `applied_result_lists_created_applied_not_applied_and_failed`.
    - `failed_row_shows_its_error`.
    - `missing_schema_disables_the_button_with_the_message`.
  - `usePendingSyncs.test.tsx`:
    - `a planned row is applied on mount`: seed a planned row with a `create`, render BoardView, and a new task card appears. The row is `applied`.
    - `a row is applied once even when the query refetches`.
    - `a block action in a planned row is reported as not applied, not run`.
- [ ] **Step 2: Run** `npx vitest run src/features/github`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npm run lint`, then `cd ../core && npx vitest run && npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** `git add board-ui/src && git commit -m "Board: Sync with GitHub, pending change sets and the sync result"`

### Owner's manual steps (after the build; agents can't do these)

- [ ] Apply the schema change in the Blocks console, as in `docs/setup/blocks-project-setup.md` section 8:
  - two new tables with their fields and unique indexes;
  - fields saved again for `FactoryDef` and `FactoryHealth`;
  - the rules deployed and Data reloaded.
- [ ] Run `factory doctor --store blocks`. Expected: `github tables` is ok.
- [ ] On the Board, open the factory's settings, set GitHub to Connected, enter the Project (for example `kazi-lakit/3`), check the status map, and save.
- [ ] On the factory machine, start `factory sync --watch --store blocks`. Within 30 s the factories page shows `watcher seen …`, and the GitHub section lists any missing option names.
- [ ] Create a task on the Board. The card shows **waiting for GitHub**, then `#<n>` within a few seconds, and the issue is on the Project in the mapped Status.
- [ ] In GitHub, add a labelled issue in Todo, and move another task's card from Backlog to Todo. Click **Sync with GitHub**. The button shows "Syncing… (waiting for the factory machine)", then the result lists the created task and the `inbox -> ready` change.
- [ ] Stop the watcher and click Sync. The button says the factory machine hasn't been seen, and the request waits. Start the watcher again, reload the Board, and the change set is applied.
