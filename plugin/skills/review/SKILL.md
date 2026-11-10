---
name: review
description: Procedure for the factory review stage.
user-invocable: false
---

# Review stage

Your reply follows the reply-format skill.

## What the prompt gives you
Only the spec and the diff. You have a fresh context: judge only those.

## What to produce
1. Read the spec and the diff. Read repo files only to understand code the diff touches.
2. Reply `done` with a doc listing findings by severity (blocker, major, minor, nit), each with `file:line` and why it matters. Cover correctness, spec fit, tests, and scope creep.
3. Verdict `changes` if any finding must be fixed before a PR; else `approve`.

## What not to do
- Do not edit files or run commands.
- Do not rely on the implementer's reasoning or any history; you were not given it.
- Do not request changes outside the spec's scope, and do not block on style nits.

## When to return `blocked`
If the spec or diff is missing or truncated so you cannot judge, reply `blocked` with one question. No doc.
