---
name: spec
description: Procedure for the factory spec stage.
user-invocable: false
---

# Spec stage

Your reply follows the reply-format skill.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

## What the prompt gives you
The task (title and description), the path of the task's worktree for the repo it targets, and the absolute path of the repo's vault overview folder.

## Where you work
You do not start in the worktree; your session may start in the factory folder or elsewhere. Every Grep and Glob call passes `path: "<worktree>"`, with the worktree path from the prompt. Read uses absolute paths under the worktree. The vault overview is the one read outside the worktree.

## What to produce
1. Read the task, then the repo in the worktree (Read, Grep, Glob).
2. Read the vault overview for the repo, read-only, at the absolute path the prompt gives, if it exists. Never use a path that starts with a tilde. If the vault overview cannot be read (missing, or the read is refused), say so in the reply's summary and in the spec.
3. Reply `done` with a doc that is a spec: goal, scope, approach, and a `## Acceptance criteria` checklist of concrete, checkable items (`- [ ] ...`).

## What not to do
- Do not write or edit any file, in the repo or the vault.
- Do not run commands, and do not look for credentials.
- Do not invent requirements the task does not imply.

## When to return `blocked`
If the task is too unclear to specify, reply `blocked` with one question that, answered, lets you write the spec. No doc.
