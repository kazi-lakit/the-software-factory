# GitHub board integration: design

Date: 2026-11-13. Status: draft, waiting for owner approval.

## 1. Intent

Today a factory can only take work from the tsf Board (Blocks Data). The owner wants two more ways to run it:

1. **GitHub-only mode.** No tsf app and no Blocks. The factory machine and GitHub are enough. Tasks are GitHub issues on a GitHub Project; the factory creates issues, picks up labelled issues, and runs the usual stages. The owner works entirely in GitHub.
2. **Connected mode.** The tsf Board stays the place where work is managed and its flow is unchanged, but each task is mirrored to an issue on a GitHub Project. The owner maps tsf statuses to Project Status options and can edit that map at any time (for example when new columns such as testing are added later). Changes made in GitHub come back to tsf only when someone clicks **Sync with GitHub** on the Board.

The tsf Board stays the default. A factory that sets nothing behaves exactly as today.

Why: teams that already live in GitHub Projects can use the factory without adopting a second tool, and teams that use the Board can still show the work to people who only look at GitHub.

## 2. Goals, non-goals, anti-goals

**Goals**
- A factory runs end to end from GitHub alone (GitHub-only mode), with only the local file store.
- A Board factory can be connected to a GitHub Project with an owner-edited status map; tsf changes reach GitHub in seconds.
- GitHub changes reach tsf only on Sync (connected mode) or before each factory step (GitHub-only mode), through one fixed set of pull rules.
- Issues created by hand in GitHub are only picked up when they carry the factory label.

**Non-goals**
- Real-time GitHub → tsf sync (webhooks). Pull is on demand.
- GitHub as the source of truth for the core's rules (status machine, version checks, doc versions, approvals). The core keeps its own store in both modes.
- Running one GitHub-only factory from two machines at once.
- Syncing comments, assignees, milestones or other Project fields beyond Status.
- A hosted sync service. Everything runs on the factory machine with its gh login.

**Anti-goals** (would be a failure even if it works)
- The browser ever holding a GitHub token.
- A GitHub card drag or label being able to skip a gate, approve a spec, plan or PR, or move a task past a step the core owns.
- A factory with no GitHub settings behaving any differently from today.
- Agents touching GitHub. Only the core does (ground rule 6 and the factory CLAUDE.md).

## 3. Constraints

- Ground rule 3 in the main spec says the Board does not use GitHub, and the main spec lists GitHub Issues and Projects as not in phase 1. This design changes both; a decision record goes in with it (section 11).
- Ground rule 1 is unchanged: nothing reaches a protected branch except through a PR the owner merges.
- GitHub access goes through the factory's own gh login (`ghUser`), as for PRs today. GitHub Projects (v2) needs the `project` scope on that login, and an org may need to approve it. `factory doctor` checks the scope.
- The Board UI never loads credentials (`board-ui` imports only `core/src/browser.ts`). Today it creates tasks directly in Blocks Data (`board-ui/src/features/newTask/NewTaskPage.tsx:263`), so it cannot create the GitHub issue itself.
- The owner may move a task only inbox→ready and anything→cancelled. Every other move is the core's, with version compare-and-set (`core/src/status.ts`). Pulling from GitHub must stay inside those same owner rights.
- The CLI already runs on a local file store with no Blocks (`--store file`, the default; `core/src/wire.ts`), with factories read from `factories/<id>/factory.yaml` (`core/src/factoriesFs.ts`).

## 4. Approaches considered

**A. GitHub as the store in GitHub-only mode.** A `GitHubStore` implements `BoardStore` (`core/src/boardStore.ts:103`): issues are tasks, Project Status is the status, versions and metadata are a hidden block in the issue body, docs and approvals are comments. Connected mode needs a separate one-way mirror.
- Gains: no local state; any machine with the gh login could run the factory.
- Costs: two GitHub code paths. Version compare-and-set would rest on issue edits, which GitHub can't do atomically, so two runs can overwrite each other. Every read is a GraphQL call: slow, and hits rate limits.

**B. One sync engine; GitHub is always a mirror plus an inbox. (Chosen by the owner.)** The core keeps its own store in both modes:
- connected mode: Blocks Data, as today; pull runs on Sync;
- GitHub-only mode: the existing local `FileStore` (`.factory/board.json`), with no Blocks at all; pull runs automatically before each factory step.

Both modes share one GitHub Projects client, the status map, the label filter, an outbox with push, the pull rules, and the `/approve` comment reader.
- Gains: the state rules stay as they are and tested; one GitHub path to build and debug; fast.
- Costs: in GitHub-only mode task state lives on the factory machine. If `.factory/board.json` is lost, open tasks are rebuilt from GitHub (section 8.5), but spec and plan version history survives only as issue comments. Two machines can't run the same GitHub-only factory.

Owner picked B because it keeps the core's rules intact, is less code, fits the local sync process chosen for instant creation, and means GitHub-only users need nothing but the factory machine and GitHub.

## 5. Factory config

GitHub settings are a new optional `github` block on the factory. With no block, nothing changes.

```yaml
# factories/<factoryId>/factory.yaml  (GitHub-only mode, file store)
github:
  mode: github-only        # or: connected
  project: kazi-lakit/3    # owner (user or org) / Project number
  label: factory           # default "factory"; "" means no label filter
  approvers: [kazi-lakit]  # who may /approve and /changes; default [ghUser]
  statusMap:               # tsf status -> Project Status option name
    inbox: Backlog
    ready: Todo
    spec: In progress
    spec_review: In progress
    plan: In progress
    plan_review: In progress
    build: In progress
    verify: In progress
    review: In progress
    pr_open: In review
    done: Merged
    blocked: In progress
    cancelled: Backlog     # plus the issue is closed as "not planned"
```

- `mode: github-only` is valid only on the file store; `mode: connected` only on the Blocks store. The core refuses the other pairing at start with a clear message.
- The issue lives in the task's repo (the factory repo's GitHub owner/name). The Project may hold issues from several repos.
- In connected mode the same block is part of the factory def in Blocks Data and is edited on the Board's factory settings page (section 9.1). In GitHub-only mode it's edited in `factory.yaml`.
- **Status map rules.** Every tsf status must map to an option that exists on the Project; `factory doctor` and the watcher check this against the live Project and name any missing option. Several tsf statuses may share one option. The map is many-to-one, so the pull direction only reads two Project options as meaningful: the one mapped from `inbox` and the one mapped from `ready` (section 8). These two must be different options. Of the other statuses, only `done` and `cancelled` may share them, because their issues are closed and the pull reads only open issues as `inbox`/`ready` (as in the example, where `cancelled` shares `Backlog`). *(Builder's call.)* When the owner later adds statuses (for example `test_ready`, `testing`), they're added to the map like any other; a status with no entry is a config error, not a silent skip.
- **Label.** Default `factory`. Empty string means every issue on the Project in the factory's repos counts. Issues the factory creates always get the label (when it isn't empty); the core creates the label in the repo if it's missing.
- **Approvers.** GitHub logins allowed to answer gates by comment (section 7). Defaults to `[ghUser]`.
- **One owner per repo.** With GitHub on, no two factories (and no two repo entries of one factory) may point at the same GitHub repo; config validation and `factory doctor` refuse it, so every labelled issue has exactly one owner. *(Builder's call.)*
- **Turning GitHub on, changing it, turning it off** *(builder's call)*:
  - Turning it on for a factory with tasks: open tasks (not `done`/`cancelled`) get issues on the next push; closed ones don't.
  - Editing the status map: every open linked task's Status is pushed again.
  - Changing `project`: open linked tasks are added to the new Project (issues stay where they are). Changing `label`: open linked issues get the new label.
  - Turning it off: pending outbox rows are dropped, links are kept, and nothing on GitHub is changed.

## 6. Push: tsf → GitHub

### 6.1 What is pushed
| tsf change | GitHub effect |
|---|---|
| Task created | Issue created in the task's repo with title, description and the label; added to the Project; Status set from the map. A hidden marker `<!-- tsf:task=<taskId> factory=<factoryId> -->` is appended to the body. |
| Status change | Project Status set from the map. `cancelled` also closes the issue as not planned; `done` closes it as completed. |
| Title or description edited in tsf | Issue title and body updated (marker kept). |
| Spec or plan written (each version) | Issue comment with the doc, headed `Spec v<N>` / `Plan v<N>`, with the reply instructions when the gate is on (section 7). |
| Task blocked | Issue comment with the blocked reason or question. |
| PR opened | `Closes #<n>` added to the PR body the core writes, so GitHub links them. |

The task stores `github: { repo, issueNumber, itemId } | null`. It's set by the first successful push.

### 6.2 Outbox and the sync process
- Every change above is written as an outbox row in the core's store, in the same write as the change itself. A pusher drains the outbox in order per task, retries with backoff, and marks rows done. A row that keeps failing (for example a missing scope) stops that task's outbox and is shown on `factory status` and, in connected mode, on the task card.
- **CLI-created tasks** (`factory new`, and so `/factory:new`) push right away in the same command. If that push fails, the task still exists and the outbox retries.
- **Board-created tasks** (connected mode) can't push from the browser. They wait in the outbox, and the card shows **waiting for GitHub** until the issue exists.
- **`factory sync --watch`** is a new long-running command on the factory machine. Every few seconds it drains the outbox for its factories and handles Sync requests (section 9.2). It uses the factory's gh login. Nothing reaches GitHub while that machine is off; the Board shows the last time the watcher was seen, from factory health.
- In GitHub-only mode `factory run` also drains the outbox before and after each step, so a separate watcher is optional there.

## 7. Gates in GitHub-only mode

There's no Board, so gates are answered on the issue.
- When a spec or plan version is written and its gate is on, the core posts it as a comment (section 6.1) and the card moves to the Status mapped from `spec_review` / `plan_review`. The comment ends with: reply `/approve` to approve, or `/changes <what to change>` to send it back.
- The next pull reads comments posted after the latest doc comment. The first `/approve` or `/changes` from a login on `approvers` becomes an `Approval` for that gate at the current doc version (the same record the Board writes today, `Approval` in `core/src/types.ts`), with the comment text as `comment`. Commands from anyone else, or posted before the latest doc comment, are ignored. The core reacts to a used command with a 👍 so the person can see it was taken.
- **PR gate.** Uses GitHub's own review and merge, mapped onto what the Board does today *(builder's call)*:
  - A GitHub PR review "Approve" from an approver is the PR gate approval. On an unprotected base the core then merges, as today; on a protected base it waits for the owner to merge in GitHub.
  - A GitHub PR review "Request changes" from an approver is a `changes` decision: the task goes back to `build` with the review text as feedback, as today.
  - A merged PR moves the task to `done`. A PR closed without merge blocks the task with reason "PR closed without merge".
  - With the PR gate off, the core merges unprotected bases itself, as today.
- Labels and card drags never answer a gate (owner's call).
- **Questions and unblocking** *(builder's call)*: the owner answers a question with `/answer <text>` from an approver login, which fills `answer` as the Board does today. `/unblock` from an approver resumes any blocked task without a question at its stage; a blocked task with no stage goes back to `ready` and starts over. This is the GitHub-only stand-in for unblocking on the Board.
- Connected mode keeps answering gates on the Board. `/approve` comments are not read there, to keep one place for decisions.

## 8. Pull: GitHub → tsf

### 8.1 When
- Connected mode: only when someone clicks **Sync with GitHub** (section 9.2).
- GitHub-only mode: automatically at the start of every `factory run` step and on each `factory sync --watch` tick.

### 8.2 What is read
For each factory with a `github` block: the Project's items in the factory's repos (Status, issue state, title, body, labels, updatedAt) and, for tasks waiting at a gate or question in GitHub-only mode, new issue comments.

### 8.3 Rules (the Sync table)
| GitHub change | tsf effect |
|---|---|
| New issue on the Project, with the label (or label empty), not yet a task | New task in `inbox`, or `ready` if its Status is the option mapped from `ready`. Title and body come from the issue; repo from the issue's repo (must be one of the factory's repos, else skipped and reported); base branch from the repo's configured default. |
| Card moved from the `inbox` option to the `ready` option | Task `inbox` → `ready`. |
| Issue closed without a merged PR | Task → `cancelled` (owner right, from any status). If the core is mid-step, the step stops at its next check, as with a Board cancel. |
| Title or body edited while the task is `inbox` or `ready` | Task title and description updated (marker stripped). |
| Label removed after work started (task past `ready`) | Task → `blocked`, reason "label removed". Adding the label back doesn't unblock it on its own; the owner unblocks as today. Label removed while `inbox`/`ready`: task → `cancelled`. |
| Any other Status move | Not applied. Listed as "not applied" in the sync result, and the next push sets the Status back from the map. |
| Title/body edited after `ready` | Not applied, listed as "not applied". The issue is not reverted. |

- Every pulled change goes through the same owner functions the Board uses (`core/src/owner.ts`), with version compare-and-set, and is recorded as a task event with source `github`.
- **Who applies it (owner's call, option A).** In GitHub-only mode the core applies pulled changes itself (the FileStore has no identity split). In connected mode the factory machine only fetches and works out the change set; the **Board, signed in as the owner**, applies it (section 9.2). The `factory-core` Blocks role is not widened. The core still writes its own fields, including the task's `github` link and `lastPushed` state, which join `CORE_TASK_FIELDS` (`core/src/blocks/store.ts:20`), and the outbox and sync-request rows.
- A pull never runs an agent and never writes approvals except through section 7.
- The pull result lists: tasks created, changes applied, changes not applied (with reason), and errors. It's printed by the CLI and shown on the Board after Sync.

### 8.4 Echo and conflicts
- Pushes made by the core are recognised on pull by comparing against the last pushed value stored per task (`github.lastPushed: { status, title, bodyHash }`), so the core doesn't re-apply its own changes.
- If the task changed in tsf and in GitHub since the last push, tsf wins and the GitHub change is listed as "not applied".

### 8.5 Rebuild (GitHub-only mode)
If `.factory/board.json` is missing or empty and the factory has a `github` block, `factory sync --rebuild` creates a task for every open issue carrying the marker for this factory, with status taken from the inverse of the status map where that is unique, else `blocked` with reason "rebuilt from GitHub, check status" and no stage, so `/unblock` sends it back to `ready` (section 7). The latest `Spec v<N>` and `Plan v<N>` comments become the current docs. Approvals are not rebuilt; gates are asked again.

## 9. Board changes (connected mode)

### 9.1 Factory settings
A **GitHub** section on the factory settings page: mode (off / connected), Project, label, and the status map as a table of tsf status → Project option. Project options are not loaded in the browser (no token); the owner types the option names and the watcher reports any name that doesn't exist on the Project in factory health, shown next to the table. Saving writes the factory def as today.

### 9.2 Sync with GitHub
- Shown only when the factory's GitHub mode is `connected`.
- Clicking it writes a sync request row (factory, requested at, by). The watcher picks it up, reads GitHub, works out the change set with the section 8.3 rules, and writes it to the row as a list of proposed owner actions (each with the task id and version it was worked out against). The Board, signed in as the owner, then applies each action through the owner functions, with version compare-and-set; an action whose task changed in the meantime is skipped and shown as "not applied". The Board shows the result (section 8.3 list) and marks the row applied. While waiting, the button shows "syncing… (waiting for the factory machine)".
- If the page is closed before the change set is applied, it stays pending on the row and is applied the next time the Board opens for that factory (re-checked against current versions).
- If the watcher hasn't been seen for 2 minutes, the button says so and still queues the request.

### 9.3 Cards
- A task with an issue shows a link to it (`#<n>`).
- A task whose create push hasn't happened yet shows **waiting for GitHub**.
- A task whose outbox is stuck shows the error.

## 10. GitHub-only mode, end to end

1. Owner creates `factories/<id>/factory.yaml` with a `github` block (`mode: github-only`) and repos, runs `factory doctor` (checks gh login, `project` scope, Project exists, every mapped option exists, label exists or can be created).
2. Owner runs `/factory:new` or `factory new`; the issue appears on the Project at once. Or the owner creates an issue in GitHub with the label and puts it in Todo.
3. `/factory:run` (or `factory run`) pulls, picks up ready tasks, runs stages. Spec and plan show up as comments; the card moves along the map.
4. Owner answers gates with `/approve` or `/changes …` on the issue, and reviews and merges the PR in GitHub.
5. Merge → `done` → issue closed, card in the `done` option.

No Blocks project, Board page or Blocks credential is needed.

## 11. Changes to existing docs and code

- Main spec, ground rule 3: becomes "The Board does not use ACR. GitHub Issues and Projects are used only as described in the GitHub board integration design, and only by the core." The phase-1 non-goal line about GitHub Issues/Projects is removed. A decision record states why and that approaches A and B were weighed.
- `FactoryDef` gains optional `github`; `Task` gains optional `github` link state (a core field); the store gains outbox rows and sync request rows (both stores: FileStore and BlocksStore, with the Blocks Data schema change documented in `docs/setup/blocks-project-setup.md`).
- `core/src/github.ts` gains Issues and Projects v2 calls behind the existing interface style, so tests run against a fake.
- New CLI: `factory sync [--watch] [--rebuild]`. `factory doctor` gains the GitHub checks.
- `plugin/skills/new` and `plugin/skills/run`: no change in what agents do; the run skill notes that pull and push happen in the core.

## 12. Testing

- Unit: status map validation, pull rules (each row of 8.3, including echo and conflict), comment command parsing and approver filter, outbox ordering and retry, rebuild.
- Integration: the full GitHub-only flow against a fake GitHub (issues, Project items, comments, PRs) on the FileStore; connected flow against the MemoryStore standing in for Blocks.
- One manual run against a real throwaway Project before release, checked off in the plan.

## 13. Build order

1. Shared GitHub client (issues, Projects v2, comments) with a fake; status map and label config with validation; `factory doctor` checks; ground rule change and decision record.
2. Outbox and push; `factory new` pushes at once; `factory sync --watch`.
3. Pull rules and `/approve` comments; GitHub-only mode end to end on the FileStore; rebuild.
4. Connected mode: Blocks schema for outbox and sync requests, Board settings section, Sync button, card states.

## 14. Left to the builder

- GraphQL query shapes, paging, and rate-limit backoff details.
- Watcher poll interval (target: outbox within a few seconds, Sync handled within ~5 s of the click).
- Exact wording of comments and the sync result layout, following existing Board style.
- Where the outbox lives inside each store, as long as it is written in the same write as the change it records.
