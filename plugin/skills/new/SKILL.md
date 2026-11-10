---
name: new
description: Draft a factory task from the user's words and give a Board link to create it (use only when the user runs /factory:new)
argument-hint: <what you want done>
disable-model-invocation: true
allowed-tools: Read, Write, Bash(node:*), Bash(printenv:*)
---

# Draft a task

Turn the user's words into a task draft and give one Board link. The link opens the New task form already filled in; the owner checks it and creates the task. You never create a task yourself.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

The factory root, written `<root>` below, is the path found in step 0: replace `<root>` with it. Write each command out in full with the real values; do not use shell variables or command substitution. Put every path argument in double quotes.

0. Run `printenv FACTORY_ROOT`. If it prints nothing, run `printenv HOME` and use `<home>/scratchpad/selise/the-software-factory`, as long as its `repos` folder exists there (Glob `<that>/repos/*.yaml`). If there is no such folder, reply `factory: factory root not found` and stop.
1. Glob `<root>/repos/*.yaml` and Read each file to learn the 7 repos and their `baseBranch`.
2. From `$ARGUMENTS` (the user's prompt), draft:
   - **repo:** the one the prompt names or clearly implies. If it is ambiguous, stop and ask the user which repo, as a plain question. Do not guess.
   - **base:** the repo's `baseBranch` (never main), unless the prompt names another branch. If the prompt asks for `main`, say the factory only targets `dev`/`stg` and use the repo's base.
   - **title:** at most about 80 characters, imperative (for example "Fix the typo in README setup steps").
   - **description:** what to change and why, in the user's terms, then an `Acceptance criteria:` list of 2 to 5 checkable bullets. Do not invent requirements the prompt does not support; list open points as questions under `Open questions:`.
3. Write the draft as JSON, `{"title": ..., "description": ..., "repo": ..., "base": ...}`, to `<root>/runs/.drafts/${CLAUDE_SESSION_ID}.json` with the Write tool.
4. Run `node "${CLAUDE_SKILL_DIR}/link.mjs" "<root>/runs/.drafts/${CLAUDE_SESSION_ID}.json"` (with the real root written in). If it fails, show its message and stop. Otherwise show the user the title, the repo and base, the description, and the link it printed. Tell them: open the link, check the form, click **Create task**, then **Mark ready**, then run `/factory:run`.
5. Stop there. Do not start `/factory:run` and do not touch the Board.
