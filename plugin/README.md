# Factory plugin

Claude Code plugin for the software factory: stage agents, skills and guard hooks.

## Two ways to run the factory

### (A) Project mode: a factory session in the factory folder

```
cd <factory root> && claude --plugin-dir plugin --add-dir ~/scratchpad/selise/vaultS/projects --strict-mcp-config
```

The whole session is guarded, all the time.

- `--add-dir ~/scratchpad/selise/vaultS/projects` gives the spec writer read access to the repo's vault overview. Without it, Claude Code refuses the read (or asks for approval, which stalls a loop). Writes there are still denied by the guard. The plugin adds no permission rules of its own; granting more is your decision.
- `--strict-mcp-config` loads no other MCP servers in the factory session. The guard covers only Bash and the write tools, so tools from your other MCP servers would run unguarded.
- If the plugin is also installed user-scoped (B), the `--plugin-dir` copy replaces the installed one for this session.

Factory sessions are only for running the factory. Do not use them for other work. The factory root's `CLAUDE.md` says so for every factory session and agent, and overrides the parent folder's instructions to keep vault notes and journals.

### (B) User-scoped install: `/factory:run` from any folder

You install it yourself, once, inside a Claude Code session:

```
/plugin marketplace add ~/scratchpad/selise/the-software-factory
/plugin install factory@the-software-factory
```

Then run `/factory:run` from any folder, for example `~/scratchpad/selise`.

- The factory root is `FACTORY_ROOT` from the shell that starts `claude`, or else the default `~/scratchpad/selise/the-software-factory`. If neither is a factory root (a folder with `repos/`, `core/` and `plugin/`), the skill stops with `factory: factory root not found`.
- The plugin loads in every session, but the guard acts only while a `/factory:run` step runs (this session's `runs/.sessions/<session id>.json` exists) and for the stage agents. Other work in the session is not touched.
- From `~/scratchpad/selise` the vault is inside the project, so no `--add-dir` is needed.
- Trade-off: in a mixed session, normal work between steps is not guarded, and your other MCP servers stay loaded during steps (there is no `--strict-mcp-config`). Use (A) when you want the whole session guarded.

### Long checks

The `check` step runs the repo's check commands in one Bash call, which the skill gives a timeout of 600000 ms (10 minutes, the Bash tool's default maximum). The implementer runs the same commands with the same timeout. If the checks need longer, set `BASH_MAX_TIMEOUT_MS` and `BASH_DEFAULT_TIMEOUT_MS` in the shell that starts `claude`, for example `BASH_MAX_TIMEOUT_MS=1800000 BASH_DEFAULT_TIMEOUT_MS=1800000 claude --plugin-dir plugin ...`. The skill passes `timeout` `600000` explicitly, which overrides the default, so also raise that value in step 4 of `skills/run/SKILL.md`.

If the timeout kills a check, no report is written and the task stays at `check`, claimed by this session. Recover with `/factory:run T-n` in the same session, which keeps the same claimant and re-runs the step. A new session has a new claimant, so it can take the task only after the claim lapses (10 minutes). Nothing renews the claim during `check`; checks longer than the claim let another session take the task (planned for the next core plan).

## Run the factory (modes 2 and 3)

A factory session needs a built core: run `cd core && npm run build` once (and after core changes), because `core/dist/` is not committed.

- Mode 3, one step by hand: `/factory:run`, or `/factory:run T-12` for one task.
- Mode 2, steady loop: `/loop 2m /factory:run --loop`.

Each run does one step of one task and stops. Pause stops new claims and the skill reports `factory: paused`; a step that is already running still finishes. If the skill reports `factory: session env missing`, the session start hook's environment did not apply (for example after `/clear` or a resume): restart the factory session. If it reports `factory: factory root not found`, set `FACTORY_ROOT` in the shell that starts `claude`, or start in the factory folder.

If the stage agent errors or returns nothing, the skill records nothing and prints `factory: agent error: ...`. Re-run `/factory:run T-n` in the same session to retry; the open run is reused.

### Known limits

- A stage agent that hits its turn limit (`maxTurns` 60) ends without a `<factory-result>` block. The core then records a malformed reply ("no `<factory-result>` block"), not a turn-limit block: verify and review go back to build (using up one return); spec, plan and build block.

## Safety layers

No single layer is the boundary. In order:

1. **The guard.** `hooks/guard.mjs` is a PreToolUse hook on Bash and the write tools. It acts for the stage agents, in a project-mode session, and while a `/factory:run` step runs; otherwise it allows everything. It is defense in depth and regex-based, so a determined agent with Bash can find forms it does not match. It denies, for everyone: Keychain access, `gh`, `git push`, remote and config changes, `ssh`, token variables, the GitHub API, any path to the vault (`vaultS`) or the user's checkouts (including `../blocks` and `../vaultS`), and `.git/hooks`, `hooksPath` and `--no-verify`. For factory agents it also denies branch changes, any git command line that mentions push, the factory CLI and `core/dist/` or `core/src/`, and state-changing git commands that do not name the step worktree. Writes are allowed only in the step worktree (agents) or under `runs/` and `.clones/worktrees/` (the main session), after resolving symlinks.
2. **The clones' pre-push hook** in `.clones/<repo>/.git/hooks/`. An agent with Bash could remove it; the guard now denies `.git/hooks`.
3. **GitHub branch protection** on `dev`, `stg` and `main`. Pushes go over your SSH key, not the PAT, so this is the real backstop for a push that slips past the first two layers. Confirm it is on for each repo the factory works on.
4. **Claude Code's permission prompts.** Keep them on; see `--dangerously-skip-permissions` above.

The Keychain item that holds the PAT can be read by any process running as you, so it limits nothing against an agent with Bash; the guard's Keychain and `core/` rules are what keep agents away from it.

Run the tests with `cd plugin && npm i && npx vitest run`.
