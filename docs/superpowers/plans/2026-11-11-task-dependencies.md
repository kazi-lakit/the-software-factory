# Task dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task can depend on other tasks; `next` does not claim a `ready` task (so its spec stage does not start) until every dependency is `pr_open`, `done` or `cancelled`.

**Architecture:** A new owner field `Task.dependsOn: string[]`, stored as JSON text on Blocks and protected from core writes. A pure, browser-safe module decides "unfinished" and cycles; the owner actions validate; `Engine.next` filters waiting `ready` tasks out of its candidates and reports `waiting` for a named one. The Board sets dependencies in its New task and edit forms and shows "Waiting on …".

**Tech Stack:** TypeScript (core, Node 24 ESM), vitest, commander; React + TanStack Query board-ui (vitest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-11-11-task-dependencies-design.md`

## Global Constraints

- Finished statuses for a dependency: exactly `pr_open`, `done`, `cancelled`. `blocked` is unfinished. A dependency id with no stored task counts as finished.
- Only `ready` tasks are gated; no new status, no change to `machine.ts` or `status.ts` moves.
- `dependsOn` is owner-only: it joins `PROTECTED_TASK_FIELDS` and `EDITABLE_FIELDS`; editable only in `inbox`/`ready`.
- Stored list: deduplicated, sorted ascending by task number (`T-2` before `T-10`). Default `[]`.
- Blocks field: String `dependsOn`, description `JSON text of the task ids this task depends on.`; missing, null, malformed or non-string-array reads as `[]`.
- Same factory only; no self-dependency; no cycles.
- CLI flag: `--depends-on <ids>`, comma-separated, on `factory new` and `factory dev add`.
- CLI output for a waiting named task: `T-5 is waiting on T-3, T-4`.
- Base branch is unchanged by this feature.
- Deploying the regenerated Blocks schema and rules is the owner's step after merge; agents never deploy or push.

## Review Focus

1. A legacy Blocks row or file-store task with no `dependsOn` key must read as `[]` and stay claimable (Task 1 test).
2. An edit of a *different* task that closes a cycle (T-1 → T-2 exists; edit T-2 to depend on T-1) must be refused, not only a cycle through the task's own new list (Task 3 test).
3. A dependency sitting in `inbox` or `ready` (not started) keeps the dependent waiting; the dependent must not be claimed ahead of it (Task 4 test).
4. A dependency that is cancelled releases the dependent on the next `next` (Task 4 test).
5. With all candidates waiting, `next()` with no task id returns `nothing to do`, not `waiting` (Task 4 test).

---

### Task 1: `dependsOn` on the task and in every store

**Files:**
- Modify: `core/src/types.ts` (`Task`), `core/src/boardStore.ts` (`NewTask`), `core/src/store.ts` (`MemoryStore.createTask`, `FileStore` load mapping ~line 383), `core/src/blocks/store.ts` (`TASK_KEYS`, `encodeTaskValue`, `decodeTask`, `createTask`), `core/src/blocks/schema.ts` (`FIELDS.FactoryTask`, `PROTECTED_TASK_FIELDS`)
- Regenerate: `blocks/data/factory/FactoryTask.fields.json`, `blocks/data/rules.json` via `npm run blocks:resources` in `core/`
- Test: `core/test/storeContract.ts`, `core/test/blocks/store.test.ts`, `core/test/blocks/schema.test.ts`, `core/test/store.test.ts`
- Fix fixtures that build a full `Task` literal (`core/test/machine.test.ts:13`, `core/test/store.test.ts:153`, board-ui `TaskCard.test.tsx` `task()` helper and similar) by adding `dependsOn: []`.

**Interfaces:**
- Produces: `Task.dependsOn: string[]`; `NewTask.dependsOn?: string[]` (stores store it as given; validation is Task 3's).

- [ ] **Step 1: Write failing tests**
  - `storeContract.ts`: `createTask` without `dependsOn` → `dependsOn: []`; with `dependsOn: ['T-1']` → read back `['T-1']`; `updateTask(id, v, { dependsOn: ['T-2'] })` round-trips.
  - `blocks/store.test.ts`: a raw `FactoryTask` row with no `dependsOn`, with `null`, with `'not json'`, with `'{"a":1}'` and with `'[1,2]'` each decodes to `dependsOn: []`; a row with `'["T-3"]'` decodes to `['T-3']`; the inserted row's `dependsOn` is the JSON text `'[]'`.
  - `blocks/schema.test.ts`: `PROTECTED_TASK_FIELDS` contains `'dependsOn'`; `generateFields('FactoryTask')` includes `{ name: 'dependsOn', type: 'String' }`.
  - `store.test.ts`: a FileStore file whose task lacks `dependsOn` loads it as `[]`.
- [ ] **Step 2: Run** `cd core && npx vitest run test/storeContract test/blocks/store test/blocks/schema test/store` — Expected: FAIL.
- [ ] **Step 3: Implement.** Encode with `JSON.stringify`; decode with a `parseStringArray(v): string[]` helper next to `parseObject` (array whose every item is a string, else `[]`). Add the field after `gateOverrides` in `FIELDS` and in `PROTECTED_TASK_FIELDS`. Run `npm run blocks:resources` and commit the regenerated JSON.
- [ ] **Step 4: Run** `cd core && npx vitest run && npm run typecheck` and `cd board-ui && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Store a task's dependencies"`

### Task 2: The dependency rules (pure, browser-safe)

**Files:**
- Create: `core/src/dependencies.ts`
- Modify: `core/src/browser.ts` (export it)
- Test: `core/test/dependencies.test.ts`, `core/test/browser.test.ts`

**Interfaces:**
- Produces:
  - `export const DEP_FINISHED: ReadonlySet<Status>` = `pr_open`, `done`, `cancelled`
  - `export function unfinishedDeps(task: Pick<Task, 'dependsOn'>, tasks: readonly Pick<Task, 'taskId' | 'status'>[]): string[]` — ids in `task.dependsOn` order whose task exists and is not finished
  - `export function normalizeDeps(ids: readonly string[]): string[]` — dedupe, sort by task number
  - `export function createsCycle(taskId: string, dependsOn: readonly string[], tasks: readonly Pick<Task, 'taskId' | 'dependsOn'>[]): boolean` — true when following `dependsOn` from `dependsOn` (using stored lists for other tasks, the given list for `taskId`) reaches `taskId`

- [ ] **Step 1: Write failing tests** (`dependencies.test.ts`)
  - `unfinishedDeps`: for each of the 13 statuses, a single dependency in that status is unfinished unless the status is `pr_open`/`done`/`cancelled`; a missing id is not reported; order follows `dependsOn`.
  - `normalizeDeps(['T-10','T-2','T-2'])` → `['T-2','T-10']`.
  - `createsCycle('T-1', ['T-1'], …)` → true; `createsCycle('T-2', ['T-1'], [{T-1 dependsOn ['T-2']}, {T-2 dependsOn []}])` → true; a three-task chain T-3→T-2→T-1 with `createsCycle('T-1', ['T-3'], …)` → true; a diamond (T-4→T-2,T-3; T-2,T-3→T-1) → false.
  - `browser.test.ts`: the browser entry exports `unfinishedDeps`.
- [ ] **Step 2: Run** `cd core && npx vitest run test/dependencies test/browser` — Expected: FAIL.
- [ ] **Step 3: Implement** in `core/src/dependencies.ts`; `createsCycle` is an iterative DFS with a visited set (no Node APIs). Add `export * from './dependencies.js';` to `browser.ts`.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the dependency rules"`

### Task 3: Owner actions set and validate dependencies

**Files:**
- Modify: `core/src/owner.ts` (`EDITABLE_FIELDS`, `insertTask`, `createTask`, `createTaskAsCore`, `editTask`)
- Test: `core/test/owner.test.ts` (runs on every store fixture)

**Interfaces:**
- Consumes: `normalizeDeps`, `createsCycle` (Task 2); `NewTask.dependsOn` (Task 1).
- Produces: `createTask` / `createTaskAsCore` input gains `dependsOn?: string[]`; `TaskEdit` gains `dependsOn` (via `EDITABLE_FIELDS`).

- [ ] **Step 1: Write failing tests** (new `describe('dependencies')` in the `describe.each(fixtures)` block)
  - create with `dependsOn: ['T-2','T-1','T-1']` stores `['T-1','T-2']`.
  - each of these throws `OwnerActionError` with code `invalid`: non-array; non-string item; unknown id (`T-99`); a task in another factory; on edit, the task's own id; an edit of T-2 to `['T-1']` when T-1 already depends on T-2 (Review Focus 2).
  - editing `dependsOn` on a `spec` task throws code `not-editable`.
  - an edit from `[]` to `['T-1']` writes one `set` event with `field: 'dependsOn'`, `from: '[]'`, `to: '["T-1"]'`; an edit that normalizes to the same list writes nothing and returns the task unchanged.
  - `createTaskAsCore` accepts `dependsOn` the same way.
- [ ] **Step 2: Run** `cd core && npx vitest run test/owner` — Expected: FAIL.
- [ ] **Step 3: Implement.** One helper `async function checkDeps(store, factoryId, taskId: string | null, deps: unknown): Promise<string[]>` that validates shape, normalizes, loads `store.listTasks()`, checks existence + same factory + self, and runs `createsCycle` (skip the cycle check for a new task: it cannot be depended on yet). Call it from `insertTask` and from `editTask` when `dependsOn` is in the patch.
- [ ] **Step 4: Run** `cd core && npx vitest run test/owner` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Set a task's dependencies on create and edit"`

### Task 4: The engine gate, the CLI and the runner

**Files:**
- Modify: `core/src/engine.ts` (`NextOutcome`, `next`), `core/src/cli.ts` (`next` output, `new` and `dev add` flags), `plugin/skills/run/SKILL.md` (step 2), `plugin/README.md` (line 56 list of printed outcomes)
- Test: `core/test/engine.test.ts`, `core/test/cli.test.ts`, plugin structural tests if they pin the skill text (`plugin/test/`)

**Interfaces:**
- Consumes: `unfinishedDeps` (Task 2); owner `dependsOn` input (Task 3).
- Produces: `NextOutcome` adds `{ kind: 'none'; reason: 'waiting'; taskId: string; waitingOn: string[] }`.

- [ ] **Step 1: Write failing tests**
  - engine: T-1 `ready`, T-2 `ready` depending on T-1 → `nextTicket` claims T-1; a second claimant then gets `nothing to do` while T-1 is in `spec`.
  - engine: T-1 in `inbox`, T-2 `ready` depending on T-1, no other tasks → `next()` returns `{ kind: 'none', reason: 'nothing to do' }` (Review Focus 3 and 5).
  - engine: move T-1 to `pr_open`, then to `cancelled` in a second case → T-2 is claimed (Review Focus 4); T-1 `blocked` → T-2 not claimed.
  - engine: `engine.next('T-2')` while T-1 is unfinished → `{ kind: 'none', reason: 'waiting', taskId: 'T-2', waitingOn: ['T-1'] }`.
  - engine: a task past `ready` (e.g. `plan`) whose dependency went back to `build` is still picked.
  - cli: `next T-2` prints `T-2 is waiting on T-1`; `new --depends-on T-1,T-2` and `dev add --depends-on T-1` store `['T-1','T-2']` / `['T-1']`.
- [ ] **Step 2: Run** `cd core && npx vitest run test/engine test/cli` — Expected: FAIL.
- [ ] **Step 3: Implement.** In `next`, add `.filter((t) => t.status !== 'ready' || unfinishedDeps(t, tasks).length === 0)` to the candidate chain only when `taskId === undefined`; for a named `ready` task with unfinished deps return the `waiting` outcome before claiming. CLI prints `${taskId} is waiting on ${waitingOn.join(', ')}`; parse `--depends-on` with `split(',').map(trim).filter(Boolean)`. In the run skill's step 2 add: "If the output contains ` is waiting on `, reply `factory: <output>` and stop." Mirror it in `plugin/README.md`.
- [ ] **Step 4: Run** `cd core && npx vitest run && npm run typecheck && npm run build`, `cd plugin && npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Wait for a task's dependencies before its spec starts"`

### Task 5: Board UI

**Files:**
- Create: `board-ui/src/features/task/DependsOnPicker.tsx` (+ `DependsOnPicker.test.tsx`)
- Modify: `board-ui/src/features/board/BoardView.tsx` (`NewTaskForm`, both `<TaskCard>` call sites), `board-ui/src/features/board/TaskCard.tsx`, `board-ui/src/features/task/TaskActions.tsx` (edit form), `board-ui/src/features/task/TaskView.tsx` (details)
- Test: `TaskCard.test.tsx`, `BoardView.test.tsx`, `TaskActions.test.tsx`, `TaskView.test.tsx`

**Interfaces:**
- Consumes: `unfinishedDeps`, `normalizeDeps` from `@factory/core`; `createTask`/`editTask` `dependsOn` (Task 3); `useBoard()` for the task list.
- Produces: `DependsOnPicker({ id, factoryId, selfId?: string, tasks: Task[], value: string[], onChange(ids: string[]): void })`; `TaskCard` gains optional prop `waitingOn?: string[]`.

- [ ] **Step 1: Write failing tests**
  - `DependsOnPicker`: lists same-factory tasks not `done`/`cancelled`, excluding `selfId`, plus already-selected ids even if done; labelled "Depends on"; checking two calls `onChange` with both ids.
  - `TaskCard`: `waitingOn={['T-3','T-4']}` renders `Waiting on T-3, T-4`; none renders nothing.
  - `BoardView`: a `ready` task depending on an `inbox` task shows the badge; creating a task with one dependency picked calls the store with `dependsOn: ['T-1']`.
  - `TaskActions`: editing an `inbox` task's dependencies saves `dependsOn`; the picker is absent for a `spec` task.
  - `TaskView`: lists each dependency as a link to its task with its status label.
- [ ] **Step 2: Run** `cd board-ui && npx vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement.** The picker is a fieldset of checkboxes (`sf-field`, existing classes). New task form keeps the selection in plain state (cleared on factory change), passes `dependsOn` to `createTask`. Edit form adds `dependsOn` to its patch only when it changed. `BoardView` computes `waitingOn = task.status === 'ready' ? unfinishedDeps(task, allTasks) : []`. `TaskView` reads `useBoard()` for the dependency statuses and shows the same badge for a waiting `ready` task.
- [ ] **Step 4: Run** `cd board-ui && npx vitest run && npm run lint` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Set and show task dependencies on the Board"`
