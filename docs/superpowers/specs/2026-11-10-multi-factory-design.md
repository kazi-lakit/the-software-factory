# Multiple factories: design

- **Date:** 2026-11-10
- **Status:** written for review. Sections were agreed one by one in chat.
- **Extends:** `docs/superpowers/specs/2026-11-09-software-factory-design.md`, called "the base spec" below. Where this spec says nothing, the base spec holds.
- **Changed 2026-11-10 (R16):** a factory's GitHub access is a gh CLI login (ghUser), not a Keychain PAT; the org must approve fine-grained PATs, and the gh login already has access.

## 1. Goal

One factory application runs several factories. Examples:
- `blocks` for the Blocks repos;
- `delta` for Delta's repos;
- `mods` for the owner's Claude Code mods;
- `tsf` for the factory itself.

The application is shared: one core and `factory` CLI, one plugin, one Board page, one Blocks project, one owner. Each factory has its own:
- Board, meaning its tasks, docs and history;
- repos;
- settings (gates, limits, pause);
- GitHub login (gh);
- protected branches;
- git commit identity;
- background-docs folder for the spec writer.

**Done means:**
- today's work is migrated into factory `blocks`;
- a second factory, defined on the Board with its own GitHub login (gh), takes one small task to a PR;
- one `/factory:run` loop serves both factories.

**Not in scope:**
- dependencies between tasks in different factories;
- more than one Board user;
- a separate Blocks project per factory.

## 2. Ground rules (additions to the base spec §2)

1. `main` is always a protected branch in every factory, whatever its configuration says. The factory never pushes to a protected branch and never opens a PR into `main`.
2. Factory and repo definitions, including the check commands the factory runs, are created and changed only by the signed-in owner. Blocks enforces this. Every change is written to History with its old and new values.
3. A factory opens PRs with the token of a gh CLI login on the owner's Mac, named by the factory's `ghUser`. gh keeps the token; the Board stores the login, never a token.
4. The base spec's ground rules still hold: agents hold no credentials, the factory doesn't touch the owner's checkouts or write to the vault, and the owner starts and stops the factory.

## 3. Data model (Blocks Data, one project)

### New tables

| Table | One row per | Fields |
|---|---|---|
| `FactoryDef` | factory | `factoryId` (lowercase `[a-z][a-z0-9-]*`), `name`, `protectedBranches` (list; `main` is always added), `gitName`, `gitEmail` (both empty means the clone's normal identity), `docsPath` (absolute folder, or empty), `ghUser` (GitHub login of the gh CLI account; empty means `kazi-lakit`), `active` (bool), `version` |
| `FactoryRepo` | repo in a factory | `factoryId`, `repoId` (lowercase `[a-z][a-z0-9-]*`, unique within its factory), `remote`, `baseBranch` (usually a protected branch such as `dev`, which the factory opens PRs into; never `main`), `checks` (JSON in the same shape as today's repo yaml `checks`), `version` |
| `FactoryHealth` | factory | `factoryId`, `ghLoggedIn` (bool), `checkedAt`. Written by the core from `factory status`, so the page can show whether the factory's gh login is logged in. Never holds a token. |

### Changes to existing tables

- `FactoryTask` gains `factoryId`. It is set at creation and can only be changed by the owner afterwards; the column EDIT rule covers it, as it covers `repo`. `repo` must be a `repoId` of that factory.
- `FactorySettings`: scopes become `<factoryId>` for a factory and `<factoryId>/<repoId>` for a repo. Resolution order is task overrides, then repo, then factory, then the built-in defaults. The old `global` scope is retired by migration.
- `FactoryEvent` gains `factoryId`. It is empty for events that belong to no factory.
- Task ids stay one sequence across all factories. Every list shows the factory next to the id.

### Access rules

| Table | Owner | Factory core |
|---|---|---|
| `FactoryDef`, `FactoryRepo` | insert, edit | read |
| `FactoryHealth` | read | insert, edit |
| `FactoryTask` | as in the base spec, plus `factoryId` owner-only on edit | as in the base spec, including insert through `factory new` |
| others | unchanged | unchanged |

### Code impact

The fixed `REPO_IDS` list and `loadAllRepoConfigs` go away. Repo ids are checked against the factory's repos on the Board. The file store, used in tests and smoke runs, reads the same definitions from `factories/<id>/factory.yaml` and `factories/<id>/repos/*.yaml`.

## 4. Board page

- **Factory picker** next to the repo filter: one factory, or **All factories**.
  - The default on first visit is All factories; after that the browser remembers the last choice.
  - In the All view, every card shows the factory, for example `delta · T-12`.
- **Waiting for you** strip at the top lists, for the selected factory or all of them:
  - blocked tasks;
  - specs and plans to review;
  - open PRs.

  Each item links to its task. The columns stay below the strip.
- **New task:** pick the factory first. The repo list shows only that factory's repos, and the base defaults to the repo's base. `main` is never allowed as a base.
- **Settings** has two tabs.
  - **Factory settings:** gates, limits and pause for the selected factory and its repos.
  - **Factories:**
    - list, add and edit factories and each factory's repos;
    - turning `active` off stops new claims in that factory;
    - a change to a check command shows the old and new commands and asks for confirmation before saving;
    - each factory shows its GitHub login and whether it was logged in, as last reported by the core (see §5), with that report's time.
- **History:** a factory filter. Definition changes appear as `you` events with old and new values.
- **Task page:** shows the factory name next to the repo.

## 5. Core, CLI, plugin and runner

### Config

`FactoryConfig` loads `FactoryDef` and `FactoryRepo` from the store and validates them:
- `main` is in `protectedBranches`;
- repo ids are unique within a factory;
- the `checks` shape is valid;
- the base branch rules from §3 hold.

An invalid factory is skipped with a logged reason; the factory never guesses.

### Engine

Everything that takes a repo config takes `(factory, repo)`.

- **Claiming:** `next` picks across all active, unpaused factories, oldest task first. It honours each factory's `maxParallel`, and an optional factory filter narrows it.
- **Gates and limits:** resolved as in §3.
- **Branch guard:** uses the factory's protected branches. `ship` refuses them, and the pre-push hook in each clone carries the factory's list.
- **Git identity:** set per worktree through `git config --worktree` (or the clone's local config) when `gitName` or `gitEmail` is set. The owner's global git config is never touched.
- **GitHub login:** `ship` reads the token of the factory's `ghUser` with `gh auth token --hostname github.com --user <ghUser>`. If that login is not logged in, the task blocks with `gh account <ghUser> is not logged in (run: gh auth login)`. Other factories are unaffected.
- **Clones:** clones live at `.clones/<factoryId>/<repoId>`. Worktrees stay at `.clones/worktrees/<taskId>`.

### CLI

- `next`, `status` and (plan 5) `run` accept `--factory <id>`, repeatable.
- `factory new` requires `--factory` unless exactly one factory is active.
- `status` shows, per factory: counts, pause state, `active`, and whether its gh login is logged in (`gh <ghUser> logged in|not logged in|unknown`). It runs `gh auth status --hostname github.com --json hosts` once and never reads a token. It also writes each factory's `FactoryHealth` row (logged in yes/no, time; never a token), so the page can show it.
- `factory migrate` is a one-time, re-runnable move to multiple factories:
  1. it creates `blocks` from `repos/*.yaml`, with protected branches `dev`, `stg`, `main` and docs path `~/scratchpad/selise/vaultS/projects`;
  2. it tags the existing tasks and events with `blocks`;
  3. it moves the `global` and per-repo settings to `blocks` scopes;
  4. it checks, read-only, that the gh login of `blocks` (`kazi-lakit`) is logged in, and reports `pending` with `run gh auth login` when it is not;
  5. it reads the Board copy back and compares it with the source;
  6. only after that, it tells the owner to remove `repos/`. The core stops reading `repos/` once `blocks` exists on the Board.

  Each step checks before it acts, so a re-run is safe and a half-finished run can be resumed. On the Blocks store the owner does steps 1 to 3 with the Board's Import, so `migrate --yes` has nothing for the core to do; `migrate --check` reports every step, the gh login included.

### Plugin

- `/factory:run [<factory>|T-n] [--loop]`. Mode 2 is `/loop 2m /factory:run --loop [<factory>]`.
- `/factory:new [--ready] [<factory>:] <prompt>` infers the factory from the repo when it isn't named, and asks when the repo is ambiguous.
- Agents get their factory's docs folder (spec) and check commands (build). The guard is unchanged: it keeps writes to the step worktree and denies pushes; protected branches are enforced by the core and the pre-push hook.

### Runner (plan 5)

`factory run [--factory <id> …]` uses the same `next` and filter.

## 6. Failure handling

| Situation | What happens |
|---|---|
| A factory's gh login is not logged in | Only that factory's `ship` blocks the task, with `gh account <ghUser> is not logged in (run: gh auth login)` |
| A factory is inactive or paused | No new claims in it; steps already running finish |
| A repo is removed or renamed while it has tasks | Its open tasks block with `repo <id> no longer exists in <factory>` |
| A check command changes mid-task | The new commands apply from the next `check`; History shows the change |
| An invalid definition is entered | The page refuses to save; the core re-validates and skips the factory with a logged reason |
| `migrate` is re-run, or fails halfway | Every step checks before acting; nothing is removed before the read-back matches |
| Blocks is unreachable | As in the base spec: 3 retries, then skip; nothing moves |

## 7. Testing

- **Core:**
  - the config loader and its validation;
  - cross-factory `next`, with the filter and per-factory `maxParallel`;
  - per-factory gates, protected branches, git identity and gh login lookup;
  - `migrate`, re-run safely and resumed after a halfway failure;
  - two factories with the same `repoId`.
- **Board page:**
  - the picker and its remembered choice;
  - the Waiting-for-you strip;
  - the Factories tab, including the check-command confirmation and validation;
  - the factory-then-repo flow in New task;
  - the History filter.
- **Plugin:** the guard and structural skill tests for the new arguments.
- **Live gate:**
  - the core reads but cannot insert or edit `FactoryDef` and `FactoryRepo`, and the owner can;
  - the core cannot change a task's `factoryId`.
- **Smoke run:** two factories on the file store, run end to end.
- **Owner's live check:**
  1. run `migrate`;
  2. add a second factory on the Board, with its GitHub login (gh);
  3. take one small task in it to a PR.

## 8. Build order

This is plan 6, built before plan 5. It starts after plan 4's live check and the merge of `feat/plugin`.

1. Core: config model, loader, `migrate`, engine and CLI.
2. Access rules and the live gate. The deploy happens after the owner sees a dry run.
3. Board page: picker, strip, Factories tab, New task, History.
4. Plugin: arguments and docs.
5. Smoke run, then the owner's live check.
