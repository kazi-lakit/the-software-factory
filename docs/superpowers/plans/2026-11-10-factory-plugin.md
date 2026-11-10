# Factory Plugin Implementation Plan (plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that runs the factory in a Claude session. `/factory:factory` does one step (mode 3, "in session"), and `/loop <interval> /factory:factory --loop` repeats it (mode 2). The plugin holds the five stage agents, one skill per stage, and the guard hooks.

**Architecture:** The plugin lives in `plugin/` and loads with `claude --plugin-dir plugin` from the factory root. `/factory:factory` calls the `factory` CLI. `next` claims a step. For `check` and `ship` it runs the CLI command. For an agent step it starts the stage subagent (`factory:<agent>`) with the ticket's context. A SubagentStop hook saves the agent's final reply to `runs/<task>/<step>.reply.md`, and `factory complete --reply` records it. The core stays the only writer to the Board and GitHub. Hooks enforce the ground rules for every tool call in a factory session:
- no credentials;
- no push;
- no writes outside the task worktree and `runs/`;
- the claim is renewed while a stage runs.

**Tech Stack:** Claude Code plugin (manifest, agents, skills, hooks), Node 24 ESM hook scripts with no dependencies, vitest; the core's TypeScript CLI (commander, zod).

**Spec:** `docs/superpowers/specs/2026-11-09-software-factory-design.md` (sections 2, 3, 7, 8, 10). Plugin facts were gathered on 2026-11-10 from code.claude.com (summary in Task 1's research note).

## Global Constraints

- Ground rules, which hold whatever the settings say:
  - Nothing reaches `dev`, `stg` or `main` except through a PR you merge.
  - Agents never hold a credential.
  - The factory never writes to your checkouts (`~/scratchpad/selise/blocks/`) or the vault (`~/scratchpad/selise/vaultS/`). The spec writer may read the vault overview `projects/blocks-<repo>/`.
- Only the core moves tasks and writes the Board or GitHub. Agents only return a reply.
- Agent names are exactly the core's `AGENT_FOR`: `spec-writer`, `planner`, `implementer`, `verifier`, `reviewer`. The plugin name is `factory`, so subagent types are `factory:<name>`.
- Stage tools (spec §7):

  | Agent | Tools |
  |---|---|
  | spec-writer, planner, verifier, reviewer | `Read, Grep, Glob` only |
  | implementer | `Read, Edit, Write, Grep, Glob, Bash` |

- The reviewer sees only the spec and the diff (fresh context; the orchestrator passes both).
- Result shape (spec §7): `{status: "done" | "blocked" | "failed", summary, question?}`, plus `verdict` (verify: pass|fail, review: approve|changes) and `doc` (spec, plan, verify, review), as `parseAgentResult` already checks.
- Claim: 10 minutes, renewed about every minute while a stage runs (spec §4).
- Every CLI call from the plugin passes `--mode session` or `--mode loop` explicitly and runs with a per-session `FACTORY_CLAIMANT` (plan 1 carry-over).
- `HUSKY=0` in factory sessions (plan 1 carry-over).
- Limits in modes 2 and 3:
  - The turn limit is the agent's `maxTurns: 60` (the default `maxTurnsPerStage`). A subagent cannot read Settings, so a changed setting applies from plan 5's SDK runner on.
  - Cost is not reported in a Claude session, so replies leave out `turns` and `costUsd`, and the cost cap applies only in mode 1 (plan 5).
  - Agent transcripts stay in Claude's own session files. `runs/<task>/<stage>.jsonl` is written by plan 5's runner.
- Hook scripts:
  - plain Node ESM (`.mjs`), no npm dependencies at run time;
  - path `${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs`;
  - factory root = `CLAUDE_PROJECT_DIR`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Agent reply without the result tags, with broken JSON, or with an empty doc.** The task takes the failed path (spec §10) and the CLI never crashes. Test: Task 2, `parseAgentReply` table.
2. **A factory agent tries `git push`, `security`, `gh`, `ssh`, or writes into your checkouts or the vault.** The hook denies it with a reason. Test: Task 3 guard table.
3. **A stage runs longer than the 10-minute claim.** The renewer keeps the claim. A failed renewal never breaks the stage, and the skill reports a `ClaimError` from `complete` instead of retrying. Tests: Task 4 renewer, Task 6 skill check.
4. **Two factory sessions on the same Mac.** They get different claimants, so neither can complete the other's step. Test: Task 4 `claimantFor`.
5. **Paused factory, nothing to do, or `next` fails.** `/factory:factory` says so in one line and changes nothing. Test: Task 6 structural check and the Task 7 smoke run.

---

### Task 1: Spike — confirm the plugin mechanics the plan relies on

These facts decide Tasks 3–6. The docs leave four of them open, so check them against the real `claude` before building on them.

**Files:**
- Create: `docs/research/2026-11-10-plugin-mechanics.md` (findings; facts only, no secrets)
- Throwaway plugin: `/private/tmp/factory-spike-plugin/` (deleted at the end)

- [ ] **Step 1: Build a throwaway plugin.** It needs:
  - `.claude-plugin/plugin.json` with `{"name":"spike"}`;
  - `agents/echo.md` (tools `Read`; body: "Reply with exactly `<factory-result>{"status":"done","summary":"ok"}</factory-result>`");
  - `hooks/hooks.json` with SessionStart, PreToolUse (matcher `*`) and SubagentStop entries. Each runs `node ${CLAUDE_PLUGIN_ROOT}/hooks/log.mjs`, which appends the raw hook stdin JSON and `process.env.FACTORY_SPIKE` to `/private/tmp/factory-spike-plugin/log.jsonl`;
  - the SessionStart hook also appends `export FACTORY_SPIKE=yes` to `$CLAUDE_ENV_FILE`.
- [ ] **Step 2: Run it once.** From `/private/tmp`, run: `claude -p --plugin-dir /private/tmp/factory-spike-plugin "Run the bash command 'echo env=$FACTORY_SPIKE', then use the Agent tool with subagent_type spike:echo and the prompt 'go', then stop."`
- [ ] **Step 3: Record the answers in the research note**, each with the log lines that prove it:
  - (a) the `subagent_type` string that worked (`spike:echo`, or what did);
  - (b) whether SubagentStop input has `last_assistant_message` and `agent_type`, and their exact values;
  - (c) whether PreToolUse inside the subagent has `agent_type` and the same `session_id` as the parent;
  - (d) whether Bash saw `FACTORY_SPIKE=yes`;
  - (e) whether hook processes see `FACTORY_SPIKE` in their env;
  - (f) the output of `claude plugin validate /private/tmp/factory-spike-plugin`.
- [ ] **Step 4: Write a ruling line under each answer for later tasks:**
  - (a) sets the subagent type string in Task 6;
  - (b) no → Task 4's reply writer is replaced by the orchestrator writing the reply with the Write tool (Task 6 fallback text);
  - (c) no `session_id` match → Task 4 renewer reads the task from the only `runs/.sessions/*.json` newer than 2 hours whose `session` matches, else skips;
  - (e) no → hooks compute the claimant from `session_id` with `claimantFor` (Task 4) rather than read env.
- [ ] **Step 5: Delete the throwaway plugin and commit the note**

```bash
rm -rf /private/tmp/factory-spike-plugin
git add docs/research/2026-11-10-plugin-mechanics.md
git commit -m "docs: plugin mechanics spike for plan 4"
```

### Task 2: Core — agent replies as text, store from env

**Files:**
- Create: `core/src/agentReply.ts`, `core/test/agentReply.test.ts`
- Modify: `core/src/cli.ts` (the `complete` command; the default for `--store`)
- Test: `core/test/cli.test.ts`

**Interfaces:**
- Consumes: `parseAgentResult(raw: string | undefined, step: AgentStep): AgentResult` (`core/src/agentResult.ts`).
- Produces: `parseAgentReply(text: string | undefined, step: AgentStep): AgentResult`. The reply format, used verbatim by Tasks 5 and 6:

```
<factory-result>
{"status":"done","summary":"one line","verdict":"pass"}
</factory-result>
<factory-doc>
…markdown doc (spec, plan, verify and review steps)…
</factory-doc>
```

`<factory-doc>` is optional for build. The JSON inside `<factory-result>` must not contain `doc`. If the doc block is present, its trimmed body becomes `doc`. The function never throws.

- [ ] **Step 1: Write the failing tests** (`agentReply.test.ts`):
  - a done spec reply with a doc block returns `{status:'done', doc:'# Spec…'}`;
  - a reply with text before and after the tags still parses;
  - a missing `<factory-result>` gives `status 'failed'` and a summary starting `invalid agent result: no <factory-result> block`;
  - broken JSON gives failed with `not valid JSON`;
  - `doc` inside the JSON gives failed with `doc belongs in <factory-doc>`;
  - a done review with an empty doc block gives failed (the summary from `parseAgentResult`: `done review result needs a doc`);
  - a blocked reply with `question` keeps the question;
  - two `<factory-result>` blocks give failed with `more than one <factory-result> block`;
  - `undefined` gives failed.
- [ ] **Step 2: Run** `cd core && npx vitest run test/agentReply.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `parseAgentReply`.** Extract the blocks with non-greedy regexes and build the JSON object (adding `doc` when the doc block is non-empty). Then delegate to `parseAgentResult(JSON.stringify(obj), step)`, so all shape rules stay in one place.
- [ ] **Step 4: Change the CLI tests first.**
  - `complete T-1 spec --reply <file>` records the doc, the same as `--result`.
  - Passing both `--result` and `--reply`, or neither, exits non-zero with `pass exactly one of --result or --reply`.
  - With `FACTORY_STORE=blocks` in env and no `--store`, the CLI uses the blocks store; check this through the existing `wire` test seam.
  - An explicit `--store file` still wins.
- [ ] **Step 5: Implement the CLI changes.**
  - In `cli.ts`, `complete` gets `--result <file>` and `--reply <file>` (both optional) with the exactly-one check.
  - Split the engine: add `Engine.completeWith(taskId: string, step: AgentStep, result: AgentResult): Promise<Task>`, which holds today's body after parsing. `Engine.complete(taskId, step, raw)` becomes `completeWith(taskId, step, parseAgentResult(raw, step))`.
  - `--reply` reads the file (a missing file gives `undefined`) and calls `completeWith(task, step, parseAgentReply(text, step))`.
  - The `--store` default becomes `process.env.FACTORY_STORE ?? 'file'`. Validate it with the existing `choice` helper.
- [ ] **Step 6: Run** `cd core && npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 7: Commit** with the message `feat(core): agent replies as tagged text, FACTORY_STORE default`.

### Task 3: Plugin scaffold and the guard hook

**Files:**
- Create:
  - `plugin/.claude-plugin/plugin.json`;
  - `plugin/package.json` (`"type":"module"`, devDependency `vitest`, script `"test":"vitest run"`);
  - `plugin/hooks/hooks.json`;
  - `plugin/hooks/lib.mjs`;
  - `plugin/hooks/guard.mjs`;
  - `plugin/test/guard.test.mjs`;
  - `plugin/README.md`.
- Modify: `.gitignore` (`plugin/node_modules`, `runs/`).

**Interfaces:**
- Produces in `plugin/hooks/lib.mjs`:
  - `readHookInput(): Promise<object>` (stdin JSON);
  - `factoryRoot(env): string` (`env.CLAUDE_PROJECT_DIR`, else `env.FACTORY_ROOT`, else throw);
  - `sessionFile(root, sessionId): string` = `<root>/runs/.sessions/<sessionId>.json` with shape `{taskId, step, worktree, mode, store, session}`;
  - `isFactoryAgent(input): boolean` (`agent_type` starts with `factory:`).
- Produces in `guard.mjs`: `decide(input, ctx: {root, home, session: {taskId, step, worktree} | null}): {deny: false} | {deny: true, reason: string}`, a pure function. The script's main part reads the input, builds ctx, and on deny prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}}` with exit 0. Any error inside the hook denies with `factory guard error: <message>` (fail closed).

Rules in `decide`, for every caller unless noted:
- **Bash.** Deny when the command matches any of:
  - `\bsecurity\b`;
  - `(^|[\s;&|(])gh\s`;
  - `git\s+push`;
  - `git\s+remote\s+(add|set-url|remove|rename)`;
  - `git\s+config\s+(?!--get)`;
  - `(^|[\s;&|(])ssh\s`;
  - `\.ssh\b`;
  - `GH_TOKEN|GITHUB_TOKEN`;
  - `api\.github\.com`;
  - the home-relative paths `scratchpad/selise/blocks` or `scratchpad/selise/vaultS`.

  For factory agents, also deny:
  - `git\s+(switch|rebase|merge|branch|checkout\s+-b)`;
  - any call of the factory CLI (`(^|[\s;&|(])factory\s`, `core/dist/cli\.js`).
- **Write, Edit, MultiEdit, NotebookEdit.** Resolve `tool_input.file_path` (or `notebook_path`).
  - Factory agents: allow only inside `ctx.session.worktree`. If there is no session, deny with `no active factory step`.
  - Main session: allow only inside `<root>/runs/` and `<root>/.clones/worktrees/`.
  - Always deny anything under `<home>/scratchpad/selise/blocks` or `<home>/scratchpad/selise/vaultS`.
- **Read, Grep, Glob.** Allowed (the spec writer reads the vault).
- **Other tools.** Allowed.
- Every deny reason starts with `factory guard:` and names the rule.

- [ ] **Step 1: Write the failing table test** (`guard.test.mjs`), one case per rule plus allowed counterparts:
  - `git commit -m x` by `factory:implementer` is allowed;
  - `git push origin x` by the main session is denied;
  - `security find-generic-password …` is denied;
  - `gh pr list` is denied, but `echo ghost` is allowed;
  - `node core/dist/cli.js next` by the main session is allowed, and by `factory:implementer` is denied;
  - an implementer Write inside its worktree is allowed, and a Write to `<root>/core/src/x.ts` is denied;
  - an implementer Write with a null session is denied;
  - a main-session Write to `<root>/runs/T-1/spec.reply.md` is allowed;
  - any Write under `<home>/scratchpad/selise/vaultS/x.md` is denied;
  - a Read of the vault overview is allowed;
  - `git checkout -- file.ts` by the implementer is allowed, and `git checkout -b other` is denied;
  - a path given as `../../` that escapes the worktree is denied (resolve before comparing).
- [ ] **Step 2: Run** `cd plugin && npm i && npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement** `lib.mjs`, `guard.mjs`, `plugin.json` (`{"name":"factory","version":"0.1.0","description":"The software factory's stage agents, skills and guard hooks"}`), and `hooks.json`: PreToolUse with matcher `Bash|Write|Edit|MultiEdit|NotebookEdit` running `node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"`.
- [ ] **Step 4: Run** `npx vitest run`, then `claude plugin validate plugin`. Expected: tests pass and validation reports no errors.
- [ ] **Step 5: Write the README.** It says:
  - how to start a factory session: `cd <factory root> && claude --plugin-dir plugin`;
  - that factory sessions are only for running the factory;
  - that the guard is defense in depth: the real limits are that the Keychain holds the PAT, the clones' pre-push hook, and the core's checks.
- [ ] **Step 6: Commit** with the message `feat(plugin): scaffold and guard hook`.

### Task 4: Session hooks — claimant and env, reply capture, claim renewal

**Files:**
- Create:
  - `plugin/hooks/session-start.mjs`;
  - `plugin/hooks/subagent-stop.mjs`;
  - `plugin/hooks/renew.mjs`;
  - `plugin/test/session.test.mjs`.
- Modify: `plugin/hooks/hooks.json`, `plugin/hooks/lib.mjs`.

**Interfaces:**
- Produces in `lib.mjs`:
  - `claimantFor(sessionId: string, host: string): string` = `claude:<host>:<first 8 chars of sessionId>`;
  - `replyTarget(input, ctx): string | null`. It returns `<root>/runs/<taskId>/<step>.reply.md` for a SubagentStop whose `agent_type` is `factory:<AGENT_FOR[step]>` and matches the session file's step. Otherwise it returns null.
  - `shouldRenew(lastRenewMs: number | null, nowMs: number): boolean`, true when there was no renewal yet or 60 000 ms or more have passed.
- `session-start.mjs` appends four lines to `$CLAUDE_ENV_FILE`:
  - `export FACTORY_CLAIMANT=<claimantFor(session_id, os.hostname())>`;
  - `export HUSKY=0`;
  - `export FACTORY_ROOT=<root>`;
  - `export FACTORY_STORE=${FACTORY_STORE:-blocks}`.

  If `CLAUDE_ENV_FILE` is unset, it writes one stderr line and exits 0.
- `subagent-stop.mjs` writes `last_assistant_message` to `replyTarget(...)` (making directories as needed). It does nothing when the target is null and never blocks (exit 0).
- `renew.mjs` is a PostToolUse hook for factory agents only. It reads the session file. When `shouldRenew` holds for the mtime of `<root>/runs/.sessions/<session>.renew`, it touches that file and starts the renewal detached, without waiting: `node <root>/core/dist/cli.js --mode <mode> --store <store> renew <taskId>` (mode and store from the session file) with env `FACTORY_CLAIMANT=claimantFor(session_id, host)`, writing its output to `<root>/runs/<taskId>/renew.log`. It never blocks or fails the tool call.

- [ ] **Step 1: Write the failing tests:**
  - `claimantFor('0123456789ab','mac')` returns `claude:mac:01234567`;
  - two session ids give different claimants;
  - `replyTarget` returns the path for a matching implementer stop;
  - `replyTarget` returns null for `agent_type: 'general-purpose'`;
  - `replyTarget` returns null when the session file's step is `spec` but the agent is `factory:reviewer`;
  - `shouldRenew(null, 0)` is true, `shouldRenew(0, 59_999)` is false, `shouldRenew(0, 60_000)` is true;
  - `session-start.mjs`, run as a child process with a temp `CLAUDE_ENV_FILE` and stdin `{"session_id":"abcdef123456"}`, writes exactly the four export lines.
- [ ] **Step 2: Run** `cd plugin && npx vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement and register the hooks** in `hooks.json`:
  - SessionStart: `session-start.mjs`;
  - SubagentStop: `subagent-stop.mjs`;
  - PostToolUse with matcher `*`: `renew.mjs`.

  Apply Task 1's rulings (b), (c) and (e) where they change this.
- [ ] **Step 4: Run** `npx vitest run`, then `claude plugin validate plugin`. Expected: both pass.
- [ ] **Step 5: Commit** with the message `feat(plugin): session env, reply capture, claim renewal`.

### Task 5: Stage agents and stage skills

**Files:**
- Create:
  - `plugin/agents/{spec-writer,planner,implementer,verifier,reviewer}.md`;
  - `plugin/skills/{spec,plan,build,verify,review}/SKILL.md`;
  - `plugin/skills/reply-format/SKILL.md`;
  - `plugin/test/agents.test.mjs`.

**Interfaces:**
- Consumes: the reply format from Task 2 (copy it into `reply-format/SKILL.md` exactly, inside a fenced block marked `reply-example`).
- Each agent file's frontmatter:
  - `name`: the agent name;
  - `description`: one line;
  - `tools`: the list from Global Constraints;
  - `model: inherit`;
  - `maxTurns: 60`;
  - `skills: [<stage skill>, reply-format]`.

  The body is three or four lines. It names the stage and says to follow the preloaded stage skill and end with a reply in the reply format.
- Stage skills: frontmatter `name`, `description`, `user-invocable: false`. The body gives the stage's procedure, in this order:
  1. what the prompt gives you;
  2. what to produce;
  3. what not to do;
  4. when to return `blocked` with a question.

Stage content:
- **spec:** read the task and the repo, plus the vault overview `~/scratchpad/selise/vaultS/projects/blocks-<repo>/` (read-only). The doc is a spec with a `## Acceptance criteria` checklist. If the task is too unclear to specify, return `blocked` with one question.
- **plan:** read the spec and the repo. The doc is a TDD plan with file paths and test names, in the style of `superpowers:writing-plans`, shortened.
- **build:**
  - Work only in the worktree the prompt names.
  - Test first; run the repo's check commands from the prompt; make local `git commit`s on the current branch.
  - Never push, switch branch, or touch other paths.
  - Feedback in the prompt (failed checks, verify or review findings, your answer) comes first.
  - No doc. `done` once the checks pass locally.
- **verify:** the prompt has the checks report and the spec's acceptance criteria. The doc lists each criterion as met or not met with evidence (file:line, test name, check output). Verdict `pass` only if the checks passed and every criterion is met.
- **review:** the prompt has only the spec and the diff, so judge only those. The doc lists findings by severity. Verdict `changes` if any finding must be fixed before a PR, else `approve`.

- [ ] **Step 1: Write the failing structural test** (`agents.test.mjs`). It parses each agent file's frontmatter (a small YAML subset parser in the test, or the `yaml` devDependency) and checks:
  - the names equal `AGENT_FOR`'s values;
  - `tools` match the Global Constraints table exactly;
  - `maxTurns` is 60;
  - every `skills` entry has a `plugin/skills/<name>/SKILL.md`;
  - each stage skill names the reply format.

  It also extracts the `reply-example` block from `reply-format/SKILL.md` and asserts that `parseAgentReply` (imported from `../core/src/agentReply.ts` through vitest) returns `status: 'done'`.
- [ ] **Step 2: Run** `cd plugin && npx vitest run test/agents.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Write** the five agents, the five stage skills and `reply-format`.
- [ ] **Step 4: Run** `npx vitest run`, then `claude plugin validate plugin`. Expected: both pass.
- [ ] **Step 5: Commit** with the message `feat(plugin): stage agents and stage skills`.

### Task 6: The `/factory:factory` skill (modes 2 and 3)

**Files:**
- Create: `plugin/skills/factory/SKILL.md`, `plugin/test/factory-skill.test.mjs`
- Modify: `plugin/README.md` (how to run modes 2 and 3)

**Interfaces:**
- Consumes:
  - CLI calls `factory next [task] --json`, `factory complete <task> <step> --reply <file>`, `factory check <task>`, `factory ship <task>`, run as `node "$FACTORY_ROOT/core/dist/cli.js" --mode <mode> …` (the store comes from `FACTORY_STORE`);
  - the session file (Task 3);
  - the reply target (Task 4);
  - the subagent type from Task 1(a).
- Frontmatter:
  - `name: factory`;
  - `description: Run one step of the software factory (use only when the user runs /factory:factory)`;
  - `argument-hint: [T-12] [--loop]`;
  - `allowed-tools: Bash, Agent, Read, Write`.
  - No `disable-model-invocation`, because `/loop` must be able to run it.

The procedure the skill gives, as numbered steps:
1. `mode = loop` if `$ARGUMENTS` contains `--loop`, else `session`. `task` = the first `T-<n>` in `$ARGUMENTS`, if any.
2. Run `next [task] --json`. If the output is `nothing to do`, reply `factory: nothing to do` and stop. If the command fails, show its stderr in one line and stop. Don't retry and don't change anything.
3. Write `$FACTORY_ROOT/runs/.sessions/${CLAUDE_SESSION_ID}.json` with `{taskId, step, worktree, mode, store: "$FACTORY_STORE", session: "${CLAUDE_SESSION_ID}"}`.
4. If the step is `check`, run `check <task>`. If it is `ship`, run `ship <task>`. Print the CLI's line, delete the session file and stop.
5. Agent step: dispatch the Agent tool with `subagent_type: factory:<AGENT_FOR[step]>`. The prompt has:
   - the task's title and description;
   - the worktree path, which is where to work and read;
   - the repo's check commands from `repos/<repo>.yaml` (build only);
   - `context.spec` / `context.plan` / `context.feedback` / `context.checks` when present.

   For review, give only the spec and `git -C <worktree> diff <baseBranch>...HEAD`. Wait for it in the foreground.
6. Run `complete <task> <step> --reply $FACTORY_ROOT/runs/<task>/<step>.reply.md`. If the reply file is missing (Task 1 ruling (b) fallback), write the subagent's final message verbatim to that path with the Write tool first.
7. Print the CLI's line (`T-12 spec_review`), delete the session file and stop. One step per invocation. A `ClaimError` or `StageError` from `complete` is reported as-is and not retried.

- [ ] **Step 1: Write the failing structural test** (`factory-skill.test.mjs`). It checks:
  - the frontmatter (no `disable-model-invocation`; `allowed-tools` as above);
  - that the body has the seven numbered steps;
  - that it mentions `--mode`, `--reply`, `nothing to do`, `runs/.sessions/` and every `factory:<agent>` type;
  - that it never mentions `git push`, `security` or `gh `.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Write the skill and the README section:**
  - mode 3: `/factory:factory` or `/factory:factory T-12`;
  - mode 2: `/loop 2m /factory:factory --loop`;
  - Pause stops new claims; a running step still finishes.
- [ ] **Step 4: Run** `npx vitest run`, then `claude plugin validate plugin`. Expected: both pass.
- [ ] **Step 5: Commit** with the message `feat(plugin): /factory:factory skill for modes 2 and 3`.

### Task 7: Smoke run on the file store (executor)

**Files:**
- Create: `plugin/test/smoke/README.md` (how the smoke was run and what it showed). Do not commit the temp folders.

- [ ] **Step 1: Set up a throwaway factory root** at `/private/tmp/factory-smoke/`:
  - a bare git repo `remote.git` with a `dev` branch and one README commit;
  - `repos/data.yaml` pointing `remote` at that bare repo, with `checks` set to `{ unit: { cwd: ., test: "true" } }` and `baseBranch: dev`;
  - symlinks `core` → the real `core/` and `plugin` → the real `plugin/`.
  - Then `FACTORY_ROOT=/private/tmp/factory-smoke node core/dist/cli.js dev add --repo data --title "Add a line to README"` and `dev ready T-1`.
- [ ] **Step 2: Run one step.** From `/private/tmp/factory-smoke`, with `FACTORY_STORE=file`, run: `claude -p --plugin-dir plugin "/factory:factory"`. Expected: the spec step runs; `runs/T-1/spec.reply.md` exists; `node core/dist/cli.js status` shows T-1 `spec_review`.
- [ ] **Step 3: Check the guard and the "nothing to do" path:**
  - Run `/factory:factory` again with T-1 waiting at the gate. Expected: `factory: nothing to do`.
  - Then run `claude -p --plugin-dir plugin "Run: git push"`. Expected: the guard's deny reason appears.
- [ ] **Step 4: Write `plugin/test/smoke/README.md`** with the commands and the observed lines. Then `rm -rf /private/tmp/factory-smoke` and commit with the message `test(plugin): file-store smoke run`.

### Task 8 (USER live check): the first real task, mode 3

You run these; the executor watches `factory status` and the Board.

- [ ] **0. Prerequisites:**
  - Save a fine-grained PAT for `kazi-lakit` with access to `SELISEdigitalplatforms/blocks-data` (contents read/write, pull requests read/write): `security add-generic-password -s the-software-factory -a github-pat -w`. It prompts for the value, hidden. Never paste the PAT in chat.
  - `cd core && npm run build`.
- [ ] **1. Create the task.** On the Board page, create a small, low-risk Data task (for example, a docs fix in `blocks-data`) and mark it ready.
- [ ] **2. Start a factory session.** In the factory root: `claude --plugin-dir plugin`, then `/factory:factory`. Expected: spec → `spec_review`. Approve the spec on the Board.
- [ ] **3. Keep going.** Run `/factory:factory` until `pr_open`. A step at a time:
  - plan;
  - build: commits in `.clones/worktrees/T-n`;
  - check;
  - verify;
  - review;
  - ship: the PR into `dev` as `kazi-lakit`.

  Expected: the Board shows the docs, runs and history at each step.
- [ ] **4. Try mode 2 for one tick** on a second small task: `/loop 2m /factory:factory --loop`. Expected: the history actor shows `· loop ·`. Stop the loop after one step.
- [ ] **5. Record the results** in the vault overview (plan 4 section). On any failure, fix it and repeat the step.
