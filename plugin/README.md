# Factory plugin

Claude Code plugin for the software factory: stage agents, skills and guard hooks.

## Start a factory session

```
cd <factory root> && claude --plugin-dir plugin
```

Factory sessions are only for running the factory. Do not use them for other work.

## Run the factory (modes 2 and 3)

A factory session needs a built core: run `cd core && npm run build` once (and after core changes), because `core/dist/` is not committed.

- Mode 3, one step by hand: `/factory:factory`, or `/factory:factory T-12` for one task.
- Mode 2, steady loop: `/loop 2m /factory:factory --loop`.

Each run does one step of one task and stops. Pause stops new claims; a step that is already running still finishes.

## The guard

`hooks/guard.mjs` is a PreToolUse hook that denies risky Bash commands and writes outside the allowed paths. It is defense in depth, not the boundary. The real limits are:

- the Keychain holds the PAT, so agents never hold a credential;
- the clones' pre-push hook;
- the core's own checks.

Run the tests with `cd plugin && npm i && npx vitest run`.
