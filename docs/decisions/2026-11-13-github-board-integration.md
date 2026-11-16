# Decision: GitHub Issues and Projects through the core

Date: 2026-11-13. Status: accepted by the owner.

Full design: [GitHub board integration design](../superpowers/specs/2026-11-13-github-board-integration-design.md).

## Context

A factory could only take work from the tsf Board (Blocks Data). The owner wants two more ways to run it:

- **GitHub-only mode:** no tsf app and no Blocks. Tasks are GitHub issues on a GitHub Project.
- **Connected mode:** the Board stays where work is managed, and each task is mirrored to an issue on a GitHub Project.

Ground rule 3 said the Board does not use GitHub, and the main spec listed GitHub Issues and Projects as not in phase 1.

## Decision

- Ground rule 3 now reads: the Board does not use ACR; GitHub Issues and Projects are used only as the integration design describes, and only by the core. The phase-1 "not in" line for GitHub is removed.
- Approach B: one sync engine, with GitHub as a mirror plus an inbox. The core keeps its own store in both modes (Blocks Data when connected, the local file store in GitHub-only mode).
- In connected mode the Board, signed in as the owner, applies changes pulled from GitHub. The `factory-core` role is not widened. In GitHub-only mode the core applies them itself.
- Agents never touch GitHub. Ground rule 1 is unchanged.

## Approaches considered

- **A. GitHub as the store in GitHub-only mode.** Issues would be tasks, with versions in the issue body. No local state, but it needs two GitHub code paths. GitHub cannot do atomic compare-and-set on issue edits, so two runs could overwrite each other. Every read is a slow, rate-limited GraphQL call.
- **B. One sync engine (chosen).** The state rules stay as they are and tested. There is one GitHub path to build and debug, and it is fast. It needs only the factory machine and GitHub in GitHub-only mode. The owner picked B for these reasons.

## Consequences

- In GitHub-only mode, task state lives on the factory machine (`.factory/board.json`). If it is lost, open tasks can be rebuilt from GitHub, but spec and plan version history survives only as issue comments.
- One machine per GitHub-only factory. Two machines cannot run the same one.
- Ground rule 3 and the main spec change, as above.
- In connected mode, pulled changes go through the owner functions, so they stay within owner rights (inbox to ready, anything to cancelled).
- More to build: a shared GitHub client, status map, outbox, pull rules, and `factory sync`.
