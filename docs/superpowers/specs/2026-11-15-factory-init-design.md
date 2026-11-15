# factory init: setup wizard and a provider-neutral factory config

Date: 2026-11-15. Status: approved by the owner on 2026-11-15.

## 1. Intent

Today a new user sets up a factory by hand-writing `factories/<id>/factory.yaml` and one `repos/<id>.yaml` per repo, logging in to gh with the right scope, creating labels and Project columns, and installing the plugin. The owner wants anyone to get from a fresh clone to a working factory by answering questions, on Mac, Linux or Windows, with no extra commands afterwards, and to change any setting later the same way. The YAML stays the real configuration and stays hand-editable.

At the same time the config stops being GitHub- and Blocks-shaped: it names where the factory lives (local files or the factory app), where work is managed (a board), where code lives (a host per repo), which login is used on each service, which model each stage agent uses, and repo checks that fit any kind of repo.

## 2. Goals, non-goals, anti-goals

**Goals**
- `git clone …; cd the-software-factory; ./setup.sh` (or `setup.cmd`) leaves a factory that `/factory:run` can run, with nothing else to type.
- `./factory init` run again offers a menu to change models, gates, approvers, status map, repos (add, change, remove), add another factory, or re-check.
- One provider-neutral config shape (section 5) that old files still load into.
- Repo checks for any repo: a named, ordered list of commands.
- The config changes live in one core library, so `factory config …` CLI commands can be added later as thin wrappers.

**Non-goals (v1)**
- Global install (`npm install -g`) and a factory home outside the clone. Later.
- `factory config …` CLI commands. Later, on top of the same library.
- Other agent harnesses (Codex and others), per-stage harnesses and exact model versions.
- Trello, Jira, GitLab, Bitbucket. The shape reserves them; the wizard offers only GitHub and validation refuses the others with "not supported yet".
- Setting up the app (`factory.source: factory-app`) from the wizard. The app's factories are created on the Board as today; the YAML for app modes is only an import template.

**Anti-goals**
- The wizard writing secrets anywhere. Only logins are stored; tokens stay in each service's own CLI login (gh today).
- A hand-edited YAML being reformatted or losing its comments when the wizard saves.
- Any change in behaviour for existing factories that the owner did not ask for: old YAML, the Board, Blocks and the GitHub integration keep working.

## 3. Constraints

- Node 22+ is already required (the core is TypeScript), so the wizard is a Node program; `setup.sh` / `setup.cmd` only bootstrap it.
- The factory itself has not been run on Windows (git worktrees, the guard hook, shell checks). The wizard and setup scripts must work on Windows; making every factory step Windows-proof is out of scope, but setup should warn if a known part is not supported there.
- The factory guard hook limits what a factory session may write; the wizard runs outside a factory session (a plain terminal), so it is not affected.
- In local mode the file store today seeds definitions from YAML only when the store is empty, and afterwards overlays only the `github` block. This must change: in local mode the YAML is the source of truth for the factory definition, its repos and its gates on every load.
- The Board edits repos with a server/client form (`board-ui/src/features/settings/RepoForm.tsx`) and Blocks stores `FactoryRepo.checks`; both must accept the new checks shape, and old rows must keep working.

## 4. Approaches considered

- **A. One config library in the core, the wizard on top (chosen by the owner).** A core module loads a factory's YAML, applies one named change, validates, and saves (keeping comments). The wizard (`factory init`) only asks questions and calls those changes. Later CLI commands reuse the changes.
- **B. Wizard as shell scripts (bash + PowerShell).** Rejected: two copies of every question and rule, nothing reusable by a later CLI, duplicated validation.
- **C. A + a prompt library (arrow-key menus).** Not chosen for v1: adds a dependency; Node's built-in readline with numbered menus works everywhere.
- **Entry point.** `factory init` (owner's call) instead of `factory new`, which already creates a task.

## 5. The config shape

One file per factory: `factories/<id>/factory.yaml`.

```yaml
factory:
  id: myapp
  name: My App
  source: local                 # local | factory-app
  docsPath: ""                  # optional, as today
  git: { name: "", email: "" }  # optional commit identity, as today (gitName/gitEmail)
  active: true
  agents:                       # model per stage; left out = the session's model
    spec: opus                  # opus | sonnet | haiku | fable (Claude Code short names: always the latest version)
    plan: opus
    build: sonnet
    verify: haiku
    review: opus

accounts:                       # login per service; never tokens
  github: my-login

board:
  source: github                # github | trello | jira | factory-app
  mirror: none                  # none | github  (only with source: factory-app)
  project: my-login/7           # board-specific settings follow (github)
  label: factory
  approvers: [my-login, teammate]
  statusMap: { … }              # optional; left out = DEFAULT_STATUS_MAP

gates: { spec: true, plan: false, pr: true }   # local mode only

repos:
  host: github                  # default host for this factory's repos
  protectedBranches: [dev, stg, main]   # default for every repo; main is always added
  list:
    - id: web
      remote: git@github.com:my-org/web.git
      host: github              # optional per-repo override
      baseBranch: main
      protectedBranches: [main] # optional per-repo override
      checks:
        - { name: install, cwd: ., run: npm ci }
        - { name: test, cwd: ., run: npm test, needs: install }
```

Rules:
- `factory.source: local` takes `board.source: github` or `none` (trello, jira reserved; see section 14 call 2). `board.source: factory-app` needs `factory.source: factory-app`. `mirror` other than `none` needs `board.source: factory-app`.
- `accounts.<service>` must exist for every service the factory uses: the board's source (or mirror) and every repo host. The PR account for a repo is `accounts[repo host]`.
- `gates` is read only in local mode. In app modes gates stay in the app's settings, edited on the Board.
- `protectedBranches` moves from the factory to `repos` (factory-wide default plus a per-repo override); `main` is always protected, as today.
- Models: the Claude Code short names only (`opus`, `sonnet`, `haiku`, `fable`), as today's `AGENT_MODELS`. The Agent tool that starts stage agents accepts only these, so exact versions are not possible in v1 (owner's call). Only Claude Code runs the factory in v1; other harnesses and per-stage harnesses are out of scope (owner's call).

**Old files.** A file in today's shape loads into the new shape: `ghUser` → `accounts.github`; `agentModels` → `factory.agents`; `gitName/gitEmail` → `factory.git`; `protectedBranches` → `repos.protectedBranches`; `github.mode: github-only` → `factory.source: local`, `board.source: github`; `github.mode: connected` → `factory.source: factory-app`, `board.source: factory-app`, `board.mirror: github`; the rest of the `github` block → `board`. Repos in `factories/<id>/repos/*.yaml` still load and join `repos.list`. The wizard, when it first saves an old file, writes the new shape (keeping comments where it can) and moves `repos/*.yaml` into `repos.list`, after asking.

**In the core.** The internal `FactoryDef` / `FactoryRepo` / `GitHubSettings` types keep working through one normaliser from the YAML shape, so the engine, stores and Board change as little as possible. `FactoryDef.ghUser` stays as the GitHub login internally (filled from `accounts.github`) until other providers exist.

**App modes.** For `factory.source: factory-app` the YAML is a template for the Board's Import (the import file format is extended to the new shape, and the old format still imports).

## 6. Checks for any repo

`checks` is an ordered list of `{ name, cwd, run, needs? }`:
- `name`: unique in the repo; shown in the check report.
- `cwd`: a folder inside the repo (relative, no `..`), as today.
- `run`: a shell command.
- `needs`: optional name of an earlier check; this check is skipped when that one did not pass. (Today's semantics: client steps are skipped when install failed, server test when build failed.)
- An empty list means the repo has no checks; the check step passes.

Old shape `{ server, client, e2e }` loads as the equivalent list: `server.build`, `server.test (needs server.build)`, `client.install`, `client.typecheck/lint/test (needs client.install)`, with the same names as today's report.

Changes: `checksSchema.ts` (both shapes in, list out), `checks.ts` `runChecks` (runs the list), Blocks `FactoryRepo.checks` (stores the list as JSON; old rows read through the same converter), and the Board's `RepoForm` (edit a list of checks: add, remove, reorder; old rows show as their list).

## 7. Setup and `factory init`

### 7.1 `setup.sh` / `setup.cmd`
1. Check Node 22+, git, Claude Code (`claude`), gh. Missing → say how to install it, stop.
2. `npm ci` in `core` and `plugin`.
3. Create `./factory` (shell) and `factory.cmd` (Windows) in the repo root that run the core CLI. Nothing global.
4. Install the plugin into Claude Code at user scope (`claude plugin marketplace add <this folder>`, `claude plugin install factory@the-software-factory`), unless already installed.
5. Start `./factory init`.

Running it again is safe: every step checks first and skips what is done.

### 7.2 `factory init`, first run (no factory yet)
1. GitHub login: if gh has no login, or the login lacks the `project` scope, run `gh auth login` / `gh auth refresh -s project` interactively and wait. Pick the login when there are several (`accounts.github`).
2. Factory name → id (lowercase, validated, unique).
3. Board: GitHub Project — pick one of the account's (and its orgs') Projects, or create a new one with the 13 default columns.
4. Approvers (default: the account).
5. Default status map? Yes → template (and the wizard creates missing columns on the Project). No → ask the Project column for each status, offering the Project's existing columns; checks the map rules (inbox ≠ ready, …).
6. Gates: which steps wait for you (spec, plan, PR; defaults spec on, plan off, PR on).
7. Models: default (session model for every stage) or per stage (opus, sonnet, haiku, fable offered).
8. Repos: ask for repo links, one per line. Then default or custom setup:
   - default: base branch = the repo's default branch (read from the host), protected branches = factory default, checks = detected (8.1);
   - custom: per repo, base branch, protected branches, and the checks list (start from detected, then add, remove, edit).
9. Write `factories/<id>/factory.yaml` (and in local mode the gates).
10. Create the label in each repo and any missing Project columns.
11. Run doctor for the factory; show each failure with its fix and offer to retry.
12. End: "Ready. Open Claude Code and run /factory:run."

### 7.3 Detected checks (default repo setup)
Read the repo's default branch tree through the host API (no clone): `package.json` scripts → install (`npm ci`/`pnpm i --frozen-lockfile`/`yarn --frozen-lockfile` by lockfile), then `typecheck`, `lint`, `test`, `build` scripts that exist; `*.sln`/`*.csproj` → `dotnet build`, `dotnet test`; `go.mod` → `go build ./...`, `go test ./...`; `pyproject.toml`/`requirements.txt` → `pytest` if present; `Cargo.toml` → `cargo build`, `cargo test`; a `Makefile` with `test` → `make test`. Several found (monorepo with `server/` and `client/`) → each with its `cwd`. Nothing found → empty list, and the wizard says so.

### 7.4 `factory init`, later runs
Menu: change models / gates / approvers / status map; add a repo; change a repo; remove a repo; add another factory; re-check (doctor). With several factories, pick the factory first. Each item shows the current value, asks only about that item, saves, and re-runs doctor.

## 8. The config library

A core module (`factoryConfigFile.ts` or similar) with:
- `loadFactoryFile(path)` → the parsed document (keeping comments and order, with the `yaml` package's Document API) and the normalised config, or validation errors with field paths.
- Named changes, each pure on the document: set models, set gates, set approvers, set status map, set board project/label, add repo, update repo, remove repo, set accounts.
- `saveFactoryFile(path, doc)` → validate, then write atomically.
- Store-aware checks the wizard runs before a change: removing a repo is refused while it has open tasks (the wizard lists them and offers to cancel them first or keep the repo).

The wizard is a thin question layer over this; prompts are behind a small interface so tests drive the wizard with scripted answers.

## 9. Local mode reads the YAML every time

In `factory.source: local` the FileStore takes the factory definition, its repos and its gates from the YAML on every load (re-read when a file changes, as the stage 2 mtime check does), not only when the store is empty. Writes of definitions through the store (`saveFactoryDef`, `saveFactoryRepo`, gate settings) in local mode go through the config library to the YAML, so there is one source of truth. Tasks, docs, runs, events and links stay in `.factory/board.json`.

## 10. Doctor additions

- The YAML validates (errors with the field path and the fix).
- Each `accounts.<service>` is a logged-in CLI login (gh today).
- Every repo's host is supported and its remote is reachable with that account; its base branch exists.
- Existing GitHub checks stay.

## 11. Changes to existing docs and code

- `core`: factories/validation (new shape + normaliser), factoriesFs (one file, `repos.list`, old layout), checksSchema/checks, FileStore local-mode source of truth, import file format, doctor, a `factory init` command, the config library, the wizard.
- `board-ui`: RepoForm checks list; import of the new format.
- Blocks: `FactoryRepo.checks` holds the list (no schema change needed if it is a JSON string field; confirm).
- Root: `setup.sh`, `setup.cmd`, generated `./factory`, `factory.cmd` (git-ignored).
- Docs: a short "Getting started" in the root README replacing hand-written YAML instructions; the YAML reference with the three templates (app only, app + GitHub, local + GitHub).

## 12. Testing

- Unit: normaliser (old → new for every field), validation rules (section 5), checks list (needs/skip, old shape conversion), detected checks per repo type, every config change (including comment preservation), remove-repo refusal.
- Wizard: scripted answers for first run (default and custom paths) and each menu item, against a temp factory folder and fake gh/host clients.
- Setup scripts: a smoke test on Linux; `setup.cmd` checked by reading on Windows (no Windows CI).
- Existing suites (core, board-ui, plugin) pass unchanged except where the checks shape and import format change.

## 13. Build order

1. Config shape, normaliser, validation; old files still load; local-mode YAML as source of truth.
2. Checks for any repo (core, Blocks, Board form).
3. Config library (load, changes, save keeping comments).
4. `factory init` wizard (first run + menu), detected checks, Project/label/column creation, doctor additions.
5. `setup.sh` / `setup.cmd`, generated `./factory`, plugin install, Getting started docs.

## 14. Calls made after the builder check (builder's calls)

1. **Fresh clone finds its root and the file store.** The plugin's hooks find the root as the folder that holds the plugin (when installed from a clone) before the old `~/scratchpad/selise/...` fallback, and default `FACTORY_STORE` to `file` only when the variable is unset. The owner sets `FACTORY_STORE=blocks` in the shell, so the owner's setup is unchanged. `setup.sh`/`setup.cmd` also run `npm run build` in `core`, because the run skill uses `core/dist/cli.js`.
2. **A local factory without a board stays valid.** `board.source` gains `none` (the default when no board is given). An old file with no `github` block maps to `factory.source: local`, `board.source: none`. Such a factory runs on `.factory/board.json` alone, as today.
3. **Definitions in board.json with no YAML** (seeded earlier, or the legacy `blocks` factory) keep loading from board.json as today. The wizard's menu offers "export to YAML" for them once. After the export, the YAML is their source of truth. The compare-and-set `version` of a YAML-backed definition is a hash of the file content, so a save fails when the file changed since it was read.
4. **New Projects get one column per status.** The wizard's "default map" for a new Project is 13 columns named after the statuses (Inbox, Ready, Spec, Spec review, Plan, Plan review, Build, Verify, Review, PR open, Done, Blocked, Cancelled), via a new `STANDARD_STATUS_MAP`. For an existing Project, the wizard offers the old 5-option `DEFAULT_STATUS_MAP` when the Project has those columns, or asks for each status.
5. **New fields are local-YAML-only in v1.** Per-repo `protectedBranches`, per-repo `host`, and `accounts` are not added to Blocks, the Board forms or the import format in v1. App-mode factories keep today's fields. The new checks list (section 6) is the exception: it goes to Blocks and the Board too, because checks are stored as JSON.
6. **The YAML owns only the factory's gates in local mode.** When the YAML has `gates`, they win over board.json. `paused`, `maxParallel`, the cost and turn limits and per-repo setting overrides stay in board.json, as today. In local mode, the code paths that change factory gates write the YAML through the config library.
7. **App-mode YAML is documentation in v1.** The three templates are in the docs. The FileStore skips a `factory.yaml` whose `factory.source` is `factory-app`, with a note. The Board's Import keeps reading the JSON format. Importing YAML into the Board comes later.

8. **Store selection (owner's call).**
   ```
   FACTORY_STORE=local | factory-app      # default: local
   FACTORY_STORE_LOCAL_PATH=              # empty = <factory folder>/.factory ; an absolute path = use that folder
   ```
   - `local` is the file store; `factory-app` is the app's database (Blocks). The old values stay as aliases: `file` = `local`, `blocks` = `factory-app`. `--store` takes the same values.
   - `FACTORY_STORE_LOCAL_PATH` moves only the store's data: `board.json`, its lock and the pull locks. It does not move factory YAMLs, runs or worktree clones (owner's call). It must be an absolute path; a relative path is refused with a clear message. The folder is created if it is missing.
   - A command that names a factory whose YAML says `factory.source: local` uses the local store, whatever `FACTORY_STORE` says. `FACTORY_STORE` decides only when no factory is named, or when the factory has no YAML.
   - The wizard sets no environment variables; a new user gets `local` by default.

## 15. Left to the builder

- Module and file names; prompt wording; menu layout.
- How the wizard lists Projects (GraphQL query) and creates columns.
- Exact detection heuristics beyond section 7.3.
- How comments are kept when converting an old file to the new shape (best effort).
