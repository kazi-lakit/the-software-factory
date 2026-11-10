# Factory plugin

Claude Code plugin for the software factory: stage agents, skills and guard hooks.

## Two ways to run the factory

### (A) Project mode: a factory session in the factory folder

```
cd <factory root> && claude --plugin-dir plugin --add-dir ~/scratchpad/selise/vaultS/projects --strict-mcp-config
```

The whole session is guarded, all the time.

- `--add-dir ~/scratchpad/selise/vaultS/projects` gives the spec writer read access to the folders your factories' `docsPath` points at (for example the vault's projects folder). Without it, Claude Code refuses the read (or asks for approval, which stalls a loop). Writes there are still denied by the guard. The plugin adds no permission rules of its own; granting more is your decision.
- `--strict-mcp-config` loads no other MCP servers in the factory session. The guard covers only Bash and the write tools, so tools from your other MCP servers would run unguarded.
- If the plugin is also installed user-scoped (B), the `--plugin-dir` copy replaces the installed one for this session.
- The session start hook exports `HUSKY=0` to every Bash call in this mode only, so the repos' git hooks never run here.

Factory sessions are only for running the factory. Do not use them for other work. The factory root's `CLAUDE.md` says so for every factory session and agent, and overrides the parent folder's instructions to keep vault notes and journals.

### (B) User-scoped install: `/factory:run` from any folder

You install it yourself, once, in one of two ways:

- Inside a Claude Code session: run `/plugin marketplace add ~/scratchpad/selise/the-software-factory`, then `/plugin install factory@the-software-factory`. The second command opens the plugin's details; choose **user scope** there.
- Or in a shell: `claude plugin marketplace add ~/scratchpad/selise/the-software-factory`, then `claude plugin install factory@the-software-factory`, which installs in user scope by default (`--scope user`).

Then run `/factory:run` from any folder, for example `~/scratchpad/selise`.

- The plugin loads in place from `plugin/` in `~/scratchpad/selise/the-software-factory`. After `git pull`, a branch switch or edits, start a new session or run `/reload-plugins`. Every Claude session on this Mac runs the hooks from whatever branch is checked out there, so keep the checkout on a branch that has the user-scope guard. Before this change, the guard blocks writes and pushes in every session. A branch without `plugin/` makes the plugin fail to load.
- The factory root is `FACTORY_ROOT` from the shell that starts `claude`, or else the default `~/scratchpad/selise/the-software-factory`. If neither is a factory root (a folder with `core/package.json` and a `plugin/.claude-plugin/plugin.json` named `factory`), the skill stops with `factory: factory root not found or session env missing`.
- The plugin loads in every session, but the guard acts only while a `/factory:run` step runs (this session's `runs/.sessions/<session id>.json` exists) and for the stage agents. Other work in the session is not touched. A session started in a factory folder is still guarded all the time, as in (A).
- If a normal session is unexpectedly guarded and the deny reason ends with `(step file <path> exists)`, a step ended without cleaning up: remove that stale `runs/.sessions/<session>.json`.
- Every tool call in every session runs the hooks, which adds about 60 to 120 ms per call.
- From `~/scratchpad/selise` the vault is inside the project, so no `--add-dir` is needed.
- Trade-off: in a mixed session, normal work between steps is not guarded, and your other MCP servers stay loaded during steps (there is no `--strict-mcp-config`). Use (A) when you want the whole session guarded.

### Both modes

- Never run factory sessions or loops with `--dangerously-skip-permissions`. With it, the regex guard is the only boundary left.
- The factory's commands carry a `HUSKY=0` prefix (`HUSKY=0 node …`, `HUSKY=0 git commit …`, `export HUSKY=0 && <check>`), so they may need their own permission approvals: a rule like `Bash(git commit:*)` doesn't cover `HUSKY=0 git commit`. The run skill's `Bash(HUSKY=0 node:*)` allowed-tools rule is not yet confirmed live; check it on the first `/factory:run`.

### Long checks

The `check` step runs the repo's check commands in one Bash call, which the skill gives a timeout of 600000 ms (10 minutes, the Bash tool's default maximum). The implementer runs the same commands with the same timeout. If the checks need longer, set `BASH_MAX_TIMEOUT_MS` and `BASH_DEFAULT_TIMEOUT_MS` in the shell that starts `claude`, for example `BASH_MAX_TIMEOUT_MS=1800000 BASH_DEFAULT_TIMEOUT_MS=1800000 claude --plugin-dir plugin ...`. The skill passes `timeout` `600000` explicitly, which overrides the default, so also raise that value in step 4 of `skills/run/SKILL.md`.

If the timeout kills a check, no report is written and the task stays at `check`, claimed by this session. Recover with `/factory:run T-n` in the same session, which keeps the same claimant and re-runs the step. A new session has a new claimant, so it can take the task only after the claim lapses (10 minutes). Nothing renews the claim during `check`; checks longer than the claim let another session take the task (planned for the next core plan).

## Run the factory (modes 2 and 3)

A factory session needs a built core: run `cd core && npm run build` once (and after core changes), because `core/dist/` is not committed.

- Mode 3, one step by hand: `/factory:run`, or `/factory:run T-12` for one task, or `/factory:run <factory>` to take work from one factory only (one factory per run; the skill passes it to the CLI as `--factory "<factory>"`, and the runner's `--factory` is repeatable). With no argument every active factory is considered.
- Mode 2, steady loop: `/loop 2m /factory:run --loop`, or `/loop 2m /factory:run <factory> --loop` for one factory.
- The runner prints `factory: paused`, `factory: inactive` or `factory: nothing to do` from the CLI. The build prompt takes the repo's check commands from the ticket's `context.checks`, and the spec prompt gets the factory's docs folder (`context.factory.docsPath`), or is told there are none.

Each run does one step of one task and stops. Pause stops new claims and the skill reports `factory: paused`; a step that is already running still finishes. If the skill reports `factory: factory root not found or session env missing` or `factory: session env missing`, the session start hook's environment did not apply (for example after `/clear` or a resume) or no factory root resolved: set `FACTORY_ROOT` in the shell that starts `claude` if the factory is not at the default path, and restart the session.

If the stage agent errors or returns nothing, the skill records nothing and prints `factory: agent error: ...`. Re-run `/factory:run T-n` in the same session to retry; the open run is reused.

### Known limits

- A stage agent that hits its turn limit (`maxTurns` 60) ends without a `<factory-result>` block. The core then records a malformed reply ("no `<factory-result>` block"), not a turn-limit block: verify and review go back to build (using up one return); spec, plan and build block.

## Create a task from a prompt

`/factory:new [--ready] [<factory>:] <what you want done>` drafts a task from your words (factory, repo, base branch, title, description with acceptance criteria) and creates it on the Board by running `factory new --factory <id>` from your session. It learns the factories and their repos from `factories --json`. The factory is the `<factory>:` prefix if you give one, else the factory whose repo your prompt names; with no match, or more than one, it asks you. The fallback Board link carries `factory` too. The task starts in **inbox**; click **Mark ready** on the Board, then run `/factory:run`. With `--ready` it starts in ready, so you can run `/factory:run` straight away. Its history reads `core · new`. After creation the factory still can't edit the title, description, repo, base branch or gate overrides; only you can, on the Board. The guard denies the factory CLI to stage agents (regex defence in depth).

This needs the Blocks rules to let the factory core insert a task (`blocks/data/rules.json`, regenerated with `npm run -s blocks:resources`). You deploy them; until then `factory new` fails with a one-line error.

If `factory new` fails, the skill shows the error and falls back to one pre-filled Board link: open it, check the form, click **Create task**, then **Mark ready**. The link goes to `https://dfrsgz-eseqz.slsblx.com` unless `FACTORY_BOARD_URL` is set in the shell that starts `claude`, and it works only once the Board page with the pre-fill change is deployed. The draft files are saved under `runs/.drafts/` in the factory folder (ignored by git).

## Safety layers

No single layer is the boundary. In order:

1. **The guard.** `hooks/guard.mjs` is a PreToolUse hook on Bash and the write tools. It acts for the stage agents, in a session started in a factory folder, and while a `/factory:run` step runs; otherwise it allows everything. It is defense in depth and regex-based, so a determined agent with Bash can find forms it does not match. It denies, for everyone: Keychain access, `gh`, `git push`, remote and config changes, `ssh`, token variables, the GitHub API, any path to the vault (`vaultS`) or the user's checkouts (including `../blocks` and `../vaultS`), and `.git/hooks`, `hooksPath` and `--no-verify`. For factory agents it also denies branch changes, any git command line that mentions push, the factory CLI and `core/dist/` or `core/src/`, and state-changing git commands that do not name the step worktree. Writes are allowed only in the step worktree (agents) or under `runs/` and `.clones/worktrees/` (the main session), after resolving symlinks.
2. **The clones' pre-push hook** in `.clones/<repo>/.git/hooks/`. An agent with Bash could remove it; the guard now denies `.git/hooks`.
3. **GitHub branch protection** on each factory's protected branches (`main` is always one). Pushes go over your SSH key, not the GitHub token, so this is the real backstop for a push that slips past the first two layers. Confirm it is on for each repo the factory works on.
4. **Claude Code's permission prompts.** Keep them on; see `--dangerously-skip-permissions` under "Both modes" above.

The core opens and reads PRs with the token of your gh CLI login (`gh auth token --user kazi-lakit`; set `FACTORY_GH_USER` for another login). gh keeps that token in your keyring, which any process running as you can read, so it limits nothing against an agent with Bash; the guard's `gh`, Keychain, token-variable and `core/` rules are what keep agents away from it.

Run the tests with `cd plugin && npm i && npx vitest run`.
