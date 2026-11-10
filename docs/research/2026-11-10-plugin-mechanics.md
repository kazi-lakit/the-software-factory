# Plugin mechanics spike (plan 4, Task 1)

Date: 2026-11-10. Claude Code 2.1.319. Throwaway plugin `spike` (manifest `{"name":"spike"}`, agent `echo` with tools `Read`, hooks SessionStart / PreToolUse `*` / SubagentStop each running `node ${CLAUDE_PLUGIN_ROOT}/hooks/log.mjs`; SessionStart also appended `export FACTORY_SPIKE=yes` to `$CLAUDE_ENV_FILE`). Run from `/private/tmp` with `claude -p --plugin-dir ... --allowedTools ...`.

## Runs

- Run 1 (brief prompt, `Bash(echo:*)` + `Agent` allowed): the harness refused `echo env=$FACTORY_SPIKE` (it cannot pre-check a `$VAR` in an allowed command), so Bash did not run. The echo agent made no tool call, so no PreToolUse fired inside the subagent.
- Run 2 (changed: Bash command `printenv FACTORY_SPIKE` with `Bash(printenv:*)`, `Read`, `Agent` allowed; the Agent prompt tells the subagent to Read the plugin.json first, so it makes one tool call). All answers below come from run 2, except where stated. Run 1 log gave the same (a), (b), (e).

## (a) subagent_type that worked

`spike:echo` (PreToolUse for Agent shows `"subagent_type":"spike:echo"`; hook input reports `"agent_type":"spike:echo"`).

Ruling for later tasks: Task 6 uses `factory:<agent>` (`<plugin name>:<agent file name>`).

## (b) SubagentStop input

Yes, both present.
`"agent_type":"spike:echo"`, `"agent_id":"aef43f2185be42ecf"`, `"last_assistant_message":"<factory-result>{\"status\":\"done\",\"summary\":\"ok\"}</factory-result>"`. Also present: `agent_transcript_path`, `stop_hook_active`, `background_tasks`.
Note: the child ran in the background-tracked form in run 2 (`background_tasks` listed the subagent as `running`); the message was still delivered in full.

Ruling for later tasks: Task 4's reply writer can read `last_assistant_message` from SubagentStop; no Write-tool fallback needed.

## (c) PreToolUse inside the subagent

Yes. The subagent's `Read` PreToolUse has `"agent_type":"spike:echo"`, `"agent_id":"aef43f2185be42ecf"` and `session_id` `c00fe7d2-c51d-4bf5-aa17-f74023987a5a`, identical to the parent's Bash and Agent PreToolUse and the SubagentStop. Parent-level PreToolUse events carry no `agent_type`/`agent_id`.

Ruling for later tasks: Task 4 may match the parent session by `session_id` and tell subagent calls apart by `agent_type`; the `runs/.sessions/*.json` fallback is not needed.

## (d) Bash saw FACTORY_SPIKE=yes

Yes. `printenv FACTORY_SPIKE` printed `yes` (run 2; the model reported it). Env-file exports from SessionStart reach later Bash calls in `claude -p`.

Ruling for later tasks: Bash-side scripts may rely on env exported through `$CLAUDE_ENV_FILE`. Allowed-tool patterns must avoid `$VAR` in the command (run 1 refusal); use `printenv`-style commands.

## (e) Hook processes see FACTORY_SPIKE

No. Every logged hook line, including PreToolUse and SubagentStop after the Bash call, has `"env_FACTORY_SPIKE":null`. The env file affects Bash tool calls only.

Ruling for later tasks: hooks compute the claimant from `session_id` with `claimantFor` (Task 4) and must not read env.

## (f) `claude plugin validate /private/tmp/factory-spike-plugin`

Result: `Validation passed with warnings` (exit shown as pass). Warnings only:
- manifest: no version, description or author;
- hooks: `${CLAUDE_PLUGIN_ROOT}` used without quotes in SessionStart, PreToolUse, SubagentStop commands (advice: wrap in double quotes or use exec form `{"command": ..., "args": [...]}`);
- directory-submission checks (do not change the result): README_MISSING, LICENSE_MISSING, ICON_MISSING.

Ruling for later tasks: quote `"${CLAUDE_PLUGIN_ROOT}/..."` in hook commands in the real plugin; add version, description, author to the manifest; README/LICENSE only matter if submitted to a directory.

## Other facts

- SessionStart input has `source:"startup"`, `session_id`, `transcript_path`, `cwd`; PreToolUse has `tool_name`, `tool_input`, `tool_use_id`, `permission_mode`.
- `hooks/hooks.json` with a top-level `"hooks"` wrapper loaded without any manifest field.
- `claude -p` printed "no stdin data received in 3s" when stdin was not redirected; pass `< /dev/null`.
