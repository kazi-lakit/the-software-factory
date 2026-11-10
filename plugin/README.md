# Factory plugin

Claude Code plugin for the software factory: stage agents, skills and guard hooks.

## Start a factory session

```
cd <factory root> && claude --plugin-dir plugin
```

Factory sessions are only for running the factory. Do not use them for other work.

## The guard

`hooks/guard.mjs` is a PreToolUse hook that denies risky Bash commands and writes outside the allowed paths. It is defense in depth, not the boundary. The real limits are:

- the Keychain holds the PAT, so agents never hold a credential;
- the clones' pre-push hook;
- the core's own checks.

Run the tests with `cd plugin && npm i && npx vitest run`.
