---
name: new
description: Draft a factory task from the user's words and create it on the Board (use only when the user runs /factory:new)
argument-hint: [--ready] [<factory>:] <what you want done>
disable-model-invocation: true
allowed-tools: Read, Write, Bash(node:*), Bash(HUSKY=0 node:*), Bash(printenv:*)
---

# Draft and create a task

Turn the user's words into a task draft and create it on the Board with the factory CLI, run from this session. The task starts in `inbox` unless the user passed `--ready`. You never edit a task afterwards and never touch the Board any other way.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

The factory root, written `<root>` below, is the path found in step 0: replace `<root>` with it. Write each command out in full with the real values; do not use shell variables or command substitution. Put every path argument in double quotes. The CLI is `HUSKY=0 node "<root>/core/dist/cli.js"` (the core must be built); it takes the store from `FACTORY_STORE` (checked in step 0), so pass no store flag.

0. Run `printenv FACTORY_ROOT` and `printenv FACTORY_STORE`. If either prints nothing, reply `factory: session env missing; start a new session` and stop: create nothing. Otherwise `<root>` is the FACTORY_ROOT path.
1. Run `HUSKY=0 node "<root>/core/dist/cli.js" --mode session factories --json` to learn the factories, their repos and each repo's `baseBranch`. If it fails, show its one-line error and stop.
2. If the first word of `$ARGUMENTS` is `--ready`, remember that and remove it from the prompt before drafting (a `--ready` anywhere else is part of the user's words). From the rest of the prompt, draft:
   - **factory:** the prompt's `<factory>:` prefix, if its first word is a factory id from step 1 followed by a colon (remove the prefix from the prompt); otherwise the one factory whose repo the prompt names. If there is no match, or more than one factory has that repo, stop and ask the user which factory, as a plain question listing the factories. Do not guess.
   - **repo:** one of the chosen factory's repos, the one the prompt names or clearly implies. If it is ambiguous, stop and ask the user which repo, as a plain question. Do not guess.
   - **base:** the repo's `baseBranch` (never main), unless the prompt names another branch. The base must match `[A-Za-z0-9._/-]+`; if it does not, stop and ask the user for a plain branch name. If the prompt asks for `main`, say the factory never uses `main` as a task base (protected branches are per factory; `main` is always protected) and use the repo's base.
   - **title:** at most about 80 characters, imperative (for example "Fix the typo in README setup steps"). Strip every `"`, backtick, `$` and backslash from the title first: it goes into the command as one double-quoted argument.
   - **description:** what to change and why, in the user's terms, then an `Acceptance criteria:` list of 2 to 5 checkable bullets. Do not invent requirements the prompt does not support; list open points as questions under `Open questions:`.
3. Write the draft as JSON, `{"title": ..., "description": ..., "factory": ..., "repo": ..., "base": ...}`, to `<root>/runs/.drafts/${CLAUDE_SESSION_ID}.json` with the Write tool (it feeds the fallback link in step 5). Then write the description alone, as plain text, to `<root>/runs/.drafts/${CLAUDE_SESSION_ID}.md`.
4. Run `HUSKY=0 node "<root>/core/dist/cli.js" --mode session new --factory "<factory>" --repo "<repo>" --base "<base>" --title "<title>" --description-file "<root>/runs/.drafts/${CLAUDE_SESSION_ID}.md"` with the real values written in. Add `--ready` at the end only if the first word of the user's arguments was `--ready`.
5. If the command succeeded, show the user the CLI's line (for example `T-3 created in inbox`), then the title, the repo and base, and the description. If the task is in inbox, tell them to click **Mark ready** on the Board, then run `/factory:run`. If it is in ready, tell them to run `/factory:run`. If the command failed, show its one-line error, then run `node "${CLAUDE_SKILL_DIR}/link.mjs" "<root>/runs/.drafts/${CLAUDE_SESSION_ID}.json"` and show the link it prints as the fallback: open it, check the form, click **Create task**, then **Mark ready**, then run `/factory:run`. If link.mjs fails too, show its message. Then stop. Do not start `/factory:run`.
