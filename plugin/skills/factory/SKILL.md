---
name: factory
description: Run one step of the software factory (use only when the user runs /factory:factory)
argument-hint: [T-12] [--loop]
allowed-tools: Bash, Agent, Read, Write
---

# Run one factory step

Run exactly one step of one task, then stop. Only the core moves tasks; you relay its output and dispatch the stage agent. Never retry a failed command and never change anything to work around a failure.

The factory root is `${CLAUDE_PROJECT_DIR}` and this session's id is `${CLAUDE_SESSION_ID}`. The CLI is `node "${CLAUDE_PROJECT_DIR}/core/dist/cli.js"` (the core must be built). It takes the store from the `FACTORY_STORE` environment variable, so pass no store flag. Write each command out in full with these values; do not use shell variables or command substitution.

1. Set `mode` to `loop` if `$ARGUMENTS` contains `--loop`, otherwise `session`. Set `task` to the first `T-<n>` in `$ARGUMENTS`, if there is one.
2. Run `node "${CLAUDE_PROJECT_DIR}/core/dist/cli.js" --mode <mode> next [task] --json`. If the output is `nothing to do`, reply `factory: nothing to do` and stop. If the command fails, show its stderr in one line and stop. The JSON ticket is `{taskId, step, worktree, runId, context: {task, spec?, plan?, feedback?, checks?}}`.
3. Write the session file `${CLAUDE_PROJECT_DIR}/runs/.sessions/${CLAUDE_SESSION_ID}.json` with the Write tool, as `{"taskId": ..., "step": ..., "worktree": ..., "mode": <mode>, "store": <store>, "session": "${CLAUDE_SESSION_ID}"}`. `step` is the ticket's `step` as it is. For `store`, run `printenv FACTORY_STORE`; if it prints nothing, use `blocks`. From here on, every path out of this skill, failures included, ends by deleting that file with `rm -f` on its literal path.
4. If `step` is `check`, run `node "${CLAUDE_PROJECT_DIR}/core/dist/cli.js" --mode <mode> check <task>`. If it is `ship`, run the same with `ship <task>`. Print the CLI's line, delete the session file and stop.
5. Otherwise the step is an agent step. Pick the agent from the step: `spec` is `factory:spec-writer`, `plan` is `factory:planner`, `build` is `factory:implementer`, `verify` is `factory:verifier`, `review` is `factory:reviewer`. First delete any old `${CLAUDE_PROJECT_DIR}/runs/<task>/<step>.reply.md` with `rm -f`, so a stale reply is never recorded. Then call the Agent tool in the foreground with that `subagent_type` and a prompt that holds:
   - the task's title and description (`context.task`);
   - the worktree path, as the place to work and read;
   - `context.spec`, `context.plan`, `context.feedback` and `context.checks`, whichever are present;
   - for `build` only: the repo's check commands, read from `${CLAUDE_PROJECT_DIR}/repos/<repo>.yaml` with the Read tool (`checks:`);
   - for `spec` only: the read-only vault overview folder, if it exists. Run `printenv HOME`, then give `<home>/scratchpad/selise/vaultS/projects/blocks-<repo>/`.

   For `review`, give the reviewer only the spec and the output of `git -C "<worktree>" diff <baseBranch>...HEAD` (`baseBranch` is in the repo file). Nothing else.
6. Run `node "${CLAUDE_PROJECT_DIR}/core/dist/cli.js" --mode <mode> complete <task> <step> --reply ${CLAUDE_PROJECT_DIR}/runs/<task>/<step>.reply.md`. The SubagentStop hook writes that reply file. If it is missing, first write the subagent's final message, verbatim, to that path with the Write tool.
7. Print the CLI's line (for example `T-12 spec_review`), delete the session file and stop. One step per invocation. If `complete` reports a `ClaimError` or a `StageError`, report it as it is, delete the session file and stop; do not retry.
