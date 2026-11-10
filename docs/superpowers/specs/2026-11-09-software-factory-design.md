# The Software Factory — design

- **Date:** 2026-11-09
- **Status:** written for review. Sections 1–9 were agreed in chat. Sections 10–12 (failure handling, testing, open checks) are new here and still need your OK.
- **Folder:** `~/scratchpad/selise/the-software-factory`
- **Overview page:** https://claude.ai/artifact/A463nqhwGcYhPAxk2ZJT9t (source in `docs/overview/`)

## 1. Goal

The factory takes a task you write on the Board and turns it into a pull request in the right Blocks repo. Agents write the spec and the plan, build the change test-first, check it, and review it. You make the decisions at the gates you have switched on, which by default are the spec and the PR.

**Done for phase 1 means:** a task written on the Board for Blocks Data ends as a PR into `dev`, with the spec, plan, test results, review and full history on the Board. You only touch it at the spec gate and the PR gate.

**Not in phase 1:**
- E2E tests (phase 2, run against the PR preview environment)
- More than one Board user
- Hosting the Board page anywhere but `localhost`
- Any change to ACR (Agent Control Room). ACR stays as it is and the factory doesn't use it.
- GitHub Issues or Projects, or any other tracker besides the Board

## 2. Ground rules

These come from you and can't be changed through settings.

1. **Protected branches:** nothing reaches `dev`, `stg` or `main` except through a PR that you merge. On any other branch, the factory may push and merge.
2. **GitHub identity:** the factory uses `kazi-lakit` through a fine-grained PAT stored in the macOS Keychain. There is no bot account.
3. **Board:** the Board is its own Blocks project in Blocks Data. It does not use GitHub or ACR.
4. **Repos:** the factory works on Blocks OS, IAM, Monitor, Logic, Data, Localization and Release, starting with Data.
5. **Start and stop:** you start the factory, and it runs until you stop it or switch on pause.
6. **No keys for agents:** agents never hold a credential. Only the factory core does.
7. **Your checkouts:** the factory never touches your checkouts or the vault. It reads the vault but never writes to it.

## 3. Architecture

Diagram: [System map](../../overview/diagrams/system-map.html)

Everything runs on your Mac except two things: the Board data, which lives in Blocks Data, and the PRs, which go to GitHub.

| Unit | What it does | Depends on |
|---|---|---|
| `core/` (TypeScript library + `factory` CLI) | Stage order, gates, claims, history, worktrees, checks, push/PR/merge rules, limits. It is the **only** writer to the Board and GitHub. | Blocks Data API, `git`, GitHub API, Keychain |
| `runner/` | Mode 1, `factory run`. It runs each agent stage through the Claude Agent SDK (TypeScript `query()`). | `core/`, Agent SDK |
| `plugin/` | The stage agents, one skill per stage, `/factory`, and the hooks. It is loaded only in factory sessions (`claude --plugin-dir`). | Claude Code |
| `board-ui/` | The Board page (React + Vite + TypeScript) on `localhost`, using Blocks hosted login (PKCE). | Blocks Data API |
| `repos/<repo>.yaml` | Per-repo settings: remote, base branch, check commands | — |
| `.clones/` | The factory's own clone of each repo, plus one worktree per task | — |

Folder layout:

```
the-software-factory/
  board-ui/   core/   runner/
  plugin/  agents/  skills/  hooks/
  repos/      os.yaml iam.yaml monitor.yaml logic.yaml data.yaml localization.yaml release.yaml
  .clones/    <repo>/ (clone)   worktrees/<task-id>/
  runs/       <task-id>/<stage>.jsonl (agent transcripts)
  docs/       overview/  superpowers/specs/  superpowers/plans/
```

## 4. Board data (Blocks Data)

There are six tables in the factory's own Blocks project.

| Table | One row per | Fields |
|---|---|---|
| `FactoryTask` | task | `taskId` (T-12), `title`, `description`, `repo`, `baseBranch`, `status`, `stage`, `branch`, `prUrl`, `attempt`, `blockedReason`, `question`, `answer` (your reply to a question or your change request, passed to the next agent), `gateOverrides`, `claimBy`, `claimUntil`, `costUsd`, `version` |
| `FactoryDoc` | version of a spec, plan, review or verify report | `taskId`, `kind`, `version`, `body` (markdown), `author`, `status` (current / superseded) |
| `FactoryApproval` | your decision at a gate | `taskId`, `gate` (spec / plan / pr), `docVersion`, `decision` (approve / changes), `comment` |
| `FactorySettings` | scope (`global` or one repo) | `gates {spec, plan, pr}`, `maxParallel`, `maxTurnsPerStage`, `maxCostPerTaskUsd`, `paused` |
| `FactoryRun` | stage run | `taskId`, `stage`, `mode` (sdk / loop / session), `agent`, `startedAt`, `endedAt`, `result`, `turns`, `costUsd` |
| `FactoryEvent` | Board change (the history) | `taskId`, `actor` (you, or agent · mode · run), `action`, `field`, `from`, `to`, `reason`, `at` |

**Who can write what** (enforced by Blocks access rules, not only in code):

| Table | You (signed in) | Factory credential |
|---|---|---|
| Task | create (or `factory new` run from your session, as the core), edit, cancel | status, claim and result fields only (title, description, repo, base branch and gate overrides are owner-only through a Blocks column write rule, checked live 2026-11-10; the core also checks this in code) |
| Doc | read | insert new versions only |
| Approval | insert | read |
| Settings | edit | read |
| Run | read | insert, finish |
| Event | insert only | insert only |

- **Tasks made by `factory new`** start in inbox unless `--ready`, with history `core · new`; the factory still can't edit the owner-only fields afterwards.
- **Approvals are tied to a version.** An approval names the doc version you read. If a newer version is written after it, the approval no longer counts.
- **Claims use a version-checked update** on `FactoryTask.version`, so only one claim can win. A claim lasts until `claimUntil` (10 minutes), and the core renews it every minute while a stage runs. If the claim expires, the task is free again.
- **Every change makes a row:** each status or field change adds a `FactoryEvent` row, written by the core or by the Board page.

## 5. Task statuses

Diagram: [Board columns](../../overview/diagrams/task-status.html)

`inbox → ready → spec → spec_review → plan → (plan_review) → build → verify → review → pr_open → done`, plus `blocked` and `cancelled`.

| Move | When |
|---|---|
| inbox → ready | You mark it Ready |
| ready → spec | The core claims it and creates the branch `factory/<task-id>-<slug>` from `baseBranch` in a new worktree |
| spec → spec_review | The spec is written and the spec gate is on. With the gate off, the task goes straight to plan |
| spec_review → plan / spec | You approve the current version, or ask for changes |
| plan → plan_review → build | Same pattern, for the plan gate (off by default) |
| verify → review / build | The checks and the acceptance criteria pass, or they fail |
| review → pr_open / build | The reviewer approves, or asks for changes |
| pr_open → done | You merge the PR, or the core merges it when the PR gate is off and the base branch isn't protected |
| pr_open → build | You ask for changes at the PR gate on the Board |
| any → blocked | The third return to build, a limit is hit, an agent reports `blocked`, or a PR is closed without being merged |
| blocked → (stage it stopped at) | You answer the question |
| any → cancelled | You cancel the task |

Only the core moves a task between statuses, and it rejects any move that isn't in this table.

`attempt` counts the returns to build, whether from verify, review or the PR gate. The third return blocks the task.

## 6. Gates

- **Three gates:** spec (on by default), plan (off by default) and PR (on by default).
- **Settings levels:** a gate can be set globally, per repo or per task (`gateOverrides`). The most specific setting wins.
- **When settings are read:** the core reads the settings when a task reaches a gate, so a change applies to tasks already in progress.
- **The PR gate can't open protected branches.** Switching it off only lets the core merge into a base branch that isn't protected. A PR into `dev`, `stg` or `main` always waits for you, and the Settings page says so.

## 7. Stages

Diagram: [One task, end to end](../../overview/diagrams/task-flow.html)

| Stage | Done by | Tools | Output |
|---|---|---|---|
| Spec | `spec-writer` agent | read-only, plus the vault overview `projects/blocks-<repo>/` (read-only) | `FactoryDoc` spec with acceptance criteria |
| Plan | `planner` agent | read-only | `FactoryDoc` plan |
| Build | `implementer` agent | Edit, Write, the repo's check commands, local `git commit` | commits on the task branch |
| Verify | core runs the checks, then the `verifier` agent | read-only | `FactoryDoc` verify report: checks and acceptance criteria |
| Review | `reviewer` agent with fresh context (sees only the spec and the diff) | read-only | `FactoryDoc` review: approve / changes |
| Ship | core | — | push, then a PR as `kazi-lakit` (or a merge, see section 6) |

**How one agent stage runs:**

Diagram: [Inside one stage run](../../overview/diagrams/stage-run.html)

- **Where it runs:** the working directory is the task worktree.
- **What the agent gets:** the stage agent's instructions and only the tools that stage needs.
- **Plugin:** the factory plugin and its hooks are loaded.
- **Limits:** `maxTurnsPerStage`, plus a cost cap checked against the cost the SDK reports.
- **Result format:** the agent returns a fixed shape, `{status: "done" | "blocked" | "failed", summary, question?}`. The core checks it before using it.
- **Recording:** the core records the run and the event. The transcript goes to `runs/<task>/<stage>.jsonl`.

## 8. Run modes

| Mode | You start it with | Who drives |
|---|---|---|
| 1. SDK runner | `factory run` | Code. Every 30 s it reads the Board, claims up to `maxParallel` (2) tasks and runs each one's next stage through the Agent SDK |
| 2. Claude loop | `/loop /factory` in a factory session | Claude repeats `/factory` on a timer |
| 3. In session | `/factory` or `/factory T-12` | Claude runs one step, with stages as subagents |

All three modes go through the same CLI:

- `factory next [task]` claims the next step and prints the stage and its context.
- `factory complete <task> <stage> --result result.json` records the result and moves the task.
- `factory check <task>` runs the repo's checks in the worktree.
- `factory ship <task>` pushes and opens the PR, or merges.
- `factory status` shows the tasks, claims and limits.

The CLI rejects four things: a skipped stage, passing a gate that is on, a claim now held by someone else (a lapsed claim nobody re-claimed is still accepted), and any change to `dev`, `stg` or `main` other than a PR. History records the mode (for example `planner · loop · run 41`).

Before running, `factory run` checks four things:
- the PAT is in the Keychain;
- the Blocks credential is in the Keychain;
- Claude is logged in;
- the factory clones are clean.

## 9. Repos and the Board page

**Repo config** (one file per repo; all seven have the same shape):

```yaml
# repos/data.yaml
repo: data
remote: git@github.com:SELISEdigitalplatforms/blocks-data.git
baseBranch: dev
checks:
  server: { cwd: server, build: dotnet build Blocks.slnx, test: dotnet test Blocks.slnx }
  client: { cwd: client, install: npm ci, typecheck: npm run type-check, lint: npm run lint, test: npm test }
  e2e: off   # phase 2: Playwright against the dev-preview.yml PR preview
```

| Repo | Remote (`SELISEdigitalplatforms/…`) | Solution |
|---|---|---|
| os | blocks-os | `BlocksOS.sln` |
| iam | blocks-iam | `BlocksIAM.sln` |
| monitor | blocks-monitor | `Blocks.slnx` |
| logic | blocks-logic | `Blocks.slnx` |
| data | blocks-data | `Blocks.slnx` |
| localization | blocks-localization | `Blocks.slnx` |
| release | blocks-release | `Blocks.slnx` |

The factory clones each repo into `.clones/<repo>` and makes one worktree per task. It never uses your checkouts in `~/scratchpad/selise/blocks/`.

**Board page views:**

| View | What it shows |
|---|---|
| Board | Status columns with a repo filter. You can create a task (title, description, repo) |
| Task | The description; the spec and plan with their versions and a diff between versions; Approve / Request changes at a gate; the branch and PR link; the runs with turns and cost; the task's history |
| History | Every event, filterable by actor, mode, task and date |
| Settings | Gates (global and per repo), parallel limit, turn and cost limits, and **Pause factory** |

## 10. Failure handling and recovery *(new: needs your OK)*

| What happens | What the factory does |
|---|---|
| Stage hits a turn or cost limit | The run is recorded as `failed` and the task goes to `blocked` with the reason |
| Agent returns `blocked` | The task goes to `blocked` with the agent's question |
| Agent returns badly shaped output | Treated as `failed`. The task goes to build only if it was in verify or review; otherwise it goes to blocked |
| Runner crashes or you press Ctrl+C | Running stages get 60 s to finish and are then stopped. Claims expire, and the next `factory run` resumes each task at its stage, in the same worktree |
| A hook blocks an action | The agent sees the refusal, and it is logged in the run. Repeated attempts end in the turn limit and then `blocked` |
| Blocks Data or GitHub is down | The core retries 3 times with backoff, then skips the task this loop. The task is not moved |
| A claim update loses to another claim | The task is skipped. This is normal and not an error |
| Pause is switched on | No new claims. Stages already running finish |

## 11. Testing *(new: needs your OK)*

- **core:** unit tests, written test-first, for the status table, gate resolution, the attempt counter, claim expiry, the branch guard and the parsing of agent results. Blocks Data, git and GitHub are behind interfaces with fakes in these tests.
- **Branch guard:** tests show that `ship` and the `pre-push` hook both refuse `dev`, `stg` and `main` for every one of the seven repo configs.
- **Integration:** one run against a throwaway local git repo with a fake remote, taking a sample task from ready to pr_open with stubbed agents.
- **Access rules:** a script run on the Blocks project, with you running the commands, checks four things:
  - the factory credential can't insert an approval or edit settings;
  - nobody can update or delete events;
  - an approval for an old doc version doesn't open the gate;
  - two claims at once give exactly one winner.
- **Board page:** vitest for the views, plus a manual check on `localhost`.
- **End to end:** the first real task on Blocks Data, watched in mode 3 before mode 1 runs unattended.

## 12. Open checks before or during the build *(new: needs your OK)*

1. **Doc size spike (done):** measured 2026-11-10. 256 KiB, 1 MiB, 4 MiB and 8 MiB all round-trip in a Blocks Data String field. Docs are capped at 4 MiB (`MAX_DOC_BYTES`). No Blocks Storage needed.
2. **Agent SDK:** the exact option names (working directory, allowed tools, plugin dir, max turns, cost reporting), and whether it can bill to your Claude subscription or needs an API key. This decides who pays and whether mode 1 is affordable.
3. **Starting limits:** `maxTurnsPerStage` and `maxCostPerTaskUsd` get starting values after check 2. You can change them in Settings.
4. **Repo:** `the-software-factory` isn't a git repo yet. Creating it (and choosing whether it has a remote) is your call.

## 13. Build order

1. Blocks project, the six tables and the access rules. You create the project and run the deploys; the doc size spike comes first.
2. `core/` and the `factory` CLI, with tests.
3. The Board page.
4. The plugin: stage agents, skills, hooks and `/factory`. Modes 2 and 3 work from this step.
5. The SDK runner: `factory run`, parallel tasks and crash recovery.
6. Blocks Data first, then OS, IAM, Monitor, Logic, Localization and Release.
