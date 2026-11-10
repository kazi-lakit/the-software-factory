---
name: run
description: Run one step of the software factory (use only when the user runs /factory:run)
argument-hint: [T-12] [--loop]
allowed-tools: Bash(HUSKY=0 node:*), Bash(printenv:*), Bash(rm -f:*), Bash(git -C:*), Agent, Read, Write
---

# Run one factory step

Run exactly one step of one task, then stop. Only the core moves tasks; you relay its output and dispatch the stage agent. Never retry a failed command and never change anything to work around a failure.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

This session's id is `${CLAUDE_SESSION_ID}`. The factory root, written `<root>` below, is the path `printenv FACTORY_ROOT` prints in step 0: replace `<root>` with the printed path. The CLI is `HUSKY=0 node "<root>/core/dist/cli.js"` (the core must be built); the `HUSKY=0` prefix keeps the repos' git hooks out of the core's git work. It takes the store from the `FACTORY_STORE` environment variable, so pass no store flag. Write each command out in full with these values; do not use shell variables or command substitution. Put every path argument in double quotes.

0. Run `printenv FACTORY_ROOT`. If it prints nothing, reply `factory: factory root not found or session env missing; set FACTORY_ROOT or restart the session` and stop. Then run `printenv FACTORY_CLAIMANT`. Unless its output ends with `:` followed by the first 8 characters of `${CLAUDE_SESSION_ID}`, reply `factory: session env missing; restart the factory session` and stop.
1. Set `mode` to `loop` if `$ARGUMENTS` contains `--loop`, otherwise `session`. Set `task` to the first `T-<n>` in `$ARGUMENTS`, if there is one.
2. Run `HUSKY=0 node "<root>/core/dist/cli.js" --mode <mode> next [task] --json`. If the output is `nothing to do`, reply `factory: nothing to do` and stop. If the output is `paused`, reply `factory: paused` and stop. If the command fails, show its stderr in one line and stop. The JSON ticket is `{taskId, step, worktree, runId, context: {task, spec?, plan?, feedback?, checks?}}`.
3. Write the session file `<root>/runs/.sessions/${CLAUDE_SESSION_ID}.json` with the Write tool, as `{"taskId": ..., "step": ..., "worktree": ..., "mode": <mode>, "store": <store>, "session": "${CLAUDE_SESSION_ID}"}`. `step` is the ticket's `step` as it is. For `store`, run `printenv FACTORY_STORE`; if it prints nothing, use `blocks`. From here on, every path out of this skill, failures included, ends by deleting that file with `rm -f "<its literal path>"`.
4. If `step` is `check`, run `HUSKY=0 node "<root>/core/dist/cli.js" --mode <mode> check <task>` with the Bash tool's `timeout` set to `600000`. If it is `ship`, run `HUSKY=0 node "<root>/core/dist/cli.js" --mode <mode> ship <task>`, also with `timeout` `600000`. Print the CLI's line, delete the session file and stop.
5. Otherwise the step is an agent step. Pick the agent from the step: `spec` is `factory:spec-writer`, `plan` is `factory:planner`, `build` is `factory:implementer`, `verify` is `factory:verifier`, `review` is `factory:reviewer`. First delete any old reply with `rm -f "<root>/runs/<task>/<step>.reply.md"`, so a stale reply is never recorded. Then call the Agent tool in the foreground (`run_in_background: false`) with that `subagent_type` and a prompt that holds:
   - the task's title and description (`context.task`);
   - the worktree path, as the place to work and read, with these rules written out: the agent does not start in the worktree, so every Bash command starts with `cd "<worktree>" &&` or uses `git -C "<worktree>"`; every Grep and Glob call passes `path: "<worktree>"`; Read uses absolute paths under the worktree;
   - `context.spec`, `context.plan`, `context.feedback` and `context.checks`, whichever are present;
   - for `build` only: the repo's check commands, read from `<root>/repos/<repo>.yaml` with the Read tool (`checks:`);
   - for `spec` only: the read-only vault overview folder as an absolute path. Run `printenv HOME`, then give `<home>/scratchpad/selise/vaultS/projects/blocks-<repo>/`.

   For `review`, give the reviewer only the spec, the output of `git -C "<worktree>" diff origin/<context.task.baseBranch>...HEAD`, and the worktree path as a read-only root for understanding the code the diff touches, with the Grep, Glob and Read rules above. Nothing else.
6. Record the agent's reply.
   - If the Agent tool reports that the agent is still running, wait for it to finish before going on.
   - If the Agent call errored, or returned no final message from the agent, do not run `complete`. Delete the session file, print `factory: agent error: <one line>; re-run /factory:run <task> to retry` and stop.
   - The SubagentStop hook writes the reply file `<root>/runs/<task>/<step>.reply.md`. If it is missing, write the text the Agent tool returned to that path with the Write tool, copied unchanged. Never compose or edit a reply, even one that looks malformed; the core handles a malformed reply.
   - Run `HUSKY=0 node "<root>/core/dist/cli.js" --mode <mode> complete <task> <step> --reply "<root>/runs/<task>/<step>.reply.md"`.
7. Print the CLI's line (for example `T-12 spec_review`), delete the session file and stop. One step per invocation. If `complete` reports a `ClaimError` or a `StageError`, report it as it is, delete the session file and stop; do not retry.
