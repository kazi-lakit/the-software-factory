# Multi-factory smoke run (file store)

Run on 2026-11-10 from a throwaway factory root `/private/tmp/factory-smoke-multi` (deleted afterwards). Two `claude -p` runs. Every command ran with `env -u FACTORY_ROOT -u FACTORY_STORE -u FACTORY_CLAIMANT FACTORY_ROOT=/private/tmp/factory-smoke-multi FACTORY_STORE=file`; `printenv` first printed the smoke root and `file`, and printed nothing for `FACTORY_CLAIMANT`.

## Setup

- `cd core && npm run build`.
- Symlinks `core` and `plugin` to the worktree's folders (a factory root by the new marker rule: `core/package.json` and `plugin/.claude-plugin/plugin.json` named `factory`).
- Two bare repos `remote-a.git`, `remote-b.git` (branch `dev`, one README commit each).
- `factories/a/factory.yaml`, `factories/b/factory.yaml` (b with `protectedBranches: [rel]`), each with `repos/api.yaml`: its own bare remote, `baseBranch: dev`, no-op checks (`"true"`), `e2e: off`.
- `node core/dist/cli.js factories` printed `a (Factory a) active: api` and `b (Factory b) active: api`.
- `new --factory a --repo api --title "Add a line to README" --description "..."` printed `T-1 created in inbox`; the same for `b` printed `T-2 created in inbox`. (`new` needs `--repo`.) `dev ready T-1` and `dev ready T-2` printed `T-n ready`.

## Runs (cwd the smoke root, stdin from `/dev/null`)

Allowed tools: `--allowedTools "Bash(HUSKY=0 node:*)" "Bash(node:*)" "Bash(printenv:*)" "Bash(rm -f:*)" "Bash(git -C:*)" Agent Read Write Grep Glob`, with `--plugin-dir /private/tmp/factory-smoke-multi/plugin`.

1. `claude -p ... -- "/factory:run b"`
   - Output: `T-2 spec_review`.
   - `status`: `factory a: ... ready=1`, `factory b: ... spec_review=1`. Only the b task moved.
   - `.clones/` held `b` and `worktrees` only (`.clones/b/api`, `.clones/worktrees/T-2`); no `.clones/a`.
2. `claude -p ... -- "/factory:run"`
   - Output: `T-1 spec_review ...` (the a task moved next); `.clones/` now held `a`, `b`, `worktrees`.
   - `status`: `factory a: ... spec_review=1`, `factory b: ... spec_review=1`, `spec_review: 2`.
   - `runs/T-1/spec.reply.md` and `runs/T-2/spec.reply.md` each hold a `<factory-result>` and a `<factory-doc>` spec; `runs/.sessions/` kept only the two `.renew` markers (session files were removed).

## Observation: run 1's renew hook used the Blocks store

`runs/T-2/renew.log` read `error: blocks: getFactoryTasks failed (HTTP 400)`, while `runs/T-1/renew.log` read `T-1 claimed until ...`. The renew hook runs `cli.js --store <session.store> renew`, and `session.store` comes from the session file the model writes in step 3 of `skills/run/SKILL.md` (the output of `printenv FACTORY_STORE`). In run 1 the model evidently wrote `blocks`; the core commands themselves (`next`, `complete`) used the file store (the task is in `spec_review` in `.factory/board.json`). No code path in the plugin sets `blocks` by itself, and the cause could not be reproduced from the logs, so nothing was changed. Risk: a model-written store value can send the background renew to the live Blocks project. See the report's concerns.

## Defects

None fixed. No core or plugin test changed.
