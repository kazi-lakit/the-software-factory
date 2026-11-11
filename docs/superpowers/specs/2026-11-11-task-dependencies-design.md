# Task dependencies: design

- **Date:** 2026-11-11
- **Status:** written for review. The design was agreed in chat.
- **Extends:** `docs/superpowers/specs/2026-11-09-software-factory-design.md` (the base spec) and `docs/superpowers/specs/2026-11-10-multi-factory-design.md`. Where this spec says nothing, those hold.

## 1. Goal

A task can depend on other tasks. The factory does not start a task's spec stage until every task it depends on is finished: in `pr_open`, `done` or `cancelled`.

**Done means:**
- the owner sets a task's dependencies when creating it (Board, `factory new`, `factory dev add`) and edits them while the task is in `inbox` or `ready`;
- `next` never claims a `ready` task with an unfinished dependency, and claims it on the first pass after the last dependency finishes;
- the Board shows which tasks a waiting task is waiting on.

**Not in scope:**
- dependencies between tasks in different factories (already out of scope in the multi-factory spec);
- changing the dependent task's base branch. It branches from its own `baseBranch` as today, even when a dependency is only at `pr_open` and its code is not yet on that branch. The owner waits for the merge or sets the base by hand;
- re-checking dependencies after a task has started. A dependency that moves back (for example its PR is closed and it returns to `build`) does not stop a dependent that is already past `ready`.

## 2. Data

- `Task` gets `dependsOn: string[]`, a list of task ids, ascending by task number, with no duplicates. Default `[]`.
- Blocks: a new String field `dependsOn` on `FactoryTask` ("JSON text of the task ids this task depends on."), stored like `gateOverrides`. A missing, null or malformed value, or anything that is not an array of strings, reads as `[]`. Existing rows keep working with no migration.
- `dependsOn` is an owner field. It is added to `PROTECTED_TASK_FIELDS`, so the core can never write it. The schema and rules files are regenerated (`tools/blocks-resources.ts`) and redeployed.
- `MemoryStore`/`FileStore`: `createTask` takes an optional `dependsOn` (default `[]`). A stored file task without the key reads as `[]`.

## 3. Setting dependencies (owner)

- `createTask`, `createTaskAsCore` and `editTask` accept `dependsOn`. `dependsOn` joins `EDITABLE_FIELDS`, so it is editable only in `inbox` or `ready`, and an edit writes the usual `set` event with the old and new lists.
- Validation (`invalid` error on failure):
  - it is an array of task ids;
  - every id names an existing task in the same factory;
  - the task does not depend on itself;
  - no cycle: following `dependsOn` from the task over all stored tasks never reaches the task again.
- Duplicates are removed and the list is sorted before it is stored.
- CLI: `factory new --depends-on <ids>` and `factory dev add --depends-on <ids>`, comma-separated (`T-3,T-4`).

## 4. The gate (engine)

- A pure function `unfinishedDeps(task, tasks)` returns the ids in `task.dependsOn` whose task is not in `pr_open`, `done` or `cancelled`. An id with no stored task counts as finished, so a waiting task cannot be stuck on a deleted row. `blocked` counts as unfinished.
- In `next()`, a `ready` task with any unfinished dependency is not a candidate. Tasks in any other status are not checked.
- `next(taskId)` on such a task returns `{ kind: 'none', reason: 'waiting', waitingOn: [...] }`. The CLI prints `T-5 is waiting on T-3, T-4`.
- No new status and no change to the state machine or the allowed moves.

## 5. Board UI

- The New task form and the edit form get a "Depends on" multi-select. It lists the same factory's other tasks that are not `done` or `cancelled`, plus any already selected.
- A `ready` task with unfinished dependencies shows "Waiting on T-3, T-4" on its card and in the task view, using the same `unfinishedDeps` from the browser-safe core.
- The task view lists the dependencies, each linking to its task, with its status.

## 6. Testing

- Unit:
  - `unfinishedDeps` for each status, for a missing task, and for `blocked`;
  - owner validation (unknown id, other factory, self, cycle, duplicates, edit outside `inbox`/`ready`) and the edit event;
  - `next()` skips a waiting task and claims the next one; a finished dependency releases it; `next(taskId)` returns the waiting reason;
  - Blocks store encode/decode, including legacy rows without the field and malformed JSON;
  - the `--depends-on` flag on `factory new` and `factory dev add`.
- Board components: the "Depends on" picker in both forms and the "Waiting on" badge.
