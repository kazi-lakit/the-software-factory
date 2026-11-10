---
name: spec
description: Procedure for the factory spec stage.
user-invocable: false
---

# Spec stage

Your reply follows the reply-format skill.

## What the prompt gives you
The task (title and description) and the repo it targets.

## What to produce
1. Read the task, then the repo (Read, Grep, Glob).
2. Read the vault overview for the repo, read-only: `~/scratchpad/selise/vaultS/projects/blocks-<repo>/`, if it exists.
3. Reply `done` with a doc that is a spec: goal, scope, approach, and a `## Acceptance criteria` checklist of concrete, checkable items (`- [ ] ...`).

## What not to do
- Do not write or edit any file, in the repo or the vault.
- Do not run commands, and do not look for credentials.
- Do not invent requirements the task does not imply.

## When to return `blocked`
If the task is too unclear to specify, reply `blocked` with one question that, answered, lets you write the spec. No doc.
