---
name: verify
description: Procedure for the factory verify stage.
user-invocable: false
---

# Verify stage

Your reply follows the reply-format skill.

## What the prompt gives you
The checks report (what the repo's check commands printed), the spec's acceptance criteria, and the path of the task's worktree.

## Where you work
You start in the factory root, not the worktree. Every Grep and Glob call passes `path: "<worktree>"`, with the worktree path from the prompt. Read uses absolute paths under the worktree.

## What to produce
1. Read the code and tests in the worktree (Read, Grep, Glob) needed to confirm each criterion.
2. Reply `done` with a doc listing every acceptance criterion as met or not met, each with evidence: `file:line`, a test name, or check output.
3. Verdict `pass` only if the checks passed and every criterion is met; otherwise `fail`, and say in the doc what is missing.

## What not to do
- Do not edit files or run commands; you only read.
- Do not pass on trust: a criterion with no evidence is not met.
- Do not add new criteria.

## When to return `blocked`
If the checks report or criteria are missing or unreadable, reply `blocked` with one question. No doc.
