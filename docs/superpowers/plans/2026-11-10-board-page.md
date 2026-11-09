# Board Page Implementation Plan (plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **USER** are run by the user (sudo, passwords, or tenant changes they approve); the executor prepares exact commands, waits, and records results.

**Goal:** A Board page in `board-ui/` where the user signs in with Blocks hosted login and works the Board as `factory-owner`. The page has four views: Board (columns), Task (docs with version diff, gate decisions, answers, runs, history), History and Settings. It reads and writes the same Blocks Data tables the core uses, through the same `BlocksStore`.

**Architecture:**
- The page is a Vite + React + TypeScript app made with `blocks new web`, as ACR did. It runs over HTTPS on the project's app domain, because hosted login keeps the session in a Secure, domain-scoped, httpOnly cookie that browsers refuse on `localhost`.
- Its data goes through the factory core's own `BlocksStore('owner')` and `SdkBlocksData`. The page uses a cookie-mode token source, so JavaScript never sees a token.
- The core is made browser-safe first.
- Every owner action (create, ready, cancel, answer, approve or request changes, edit, settings) lives in one new core module. The page and `factory dev` both use it, so the rules and the history rows are identical.

**Tech Stack:** what `blocks new web` generates (React 18, Vite, TanStack Query, Tailwind, vitest + jsdom + Testing Library), `@seliseblocks/client` 0.3.0, `@noble/hashes`, `diff` (line diff for doc versions).

**Spec:** `docs/superpowers/specs/2026-11-09-software-factory-design.md` §4, §5, §6, §9. The spec says "localhost"; this plan keeps the page local to your Mac but serves it on `https://<app-domain>:5173` with a hosts-file line, because of the cookie (research note headline 1). Research: `docs/research/2026-11-10-board-page-from-acr.md`. ACR is read-only at `~/scratchpad/selise/build-with-blocks/agent-control-room` and is never modified.

## Global Constraints

- Paths are relative to `~/scratchpad/selise/the-software-factory`. The page lives in `board-ui/`. Shared logic lives in `core/src`.
- **The browser must never load the factory credential.** `board-ui` imports only from `core/src/browser.ts`. That entry must never pull in `credential.ts`, `secrets.ts`, `token.ts`'s `ClientCredentialsToken`, `store.ts`'s FileStore, `git.ts`, `github.ts`, `checks.ts`, `wire.ts` or `cli.ts`. A test proves this (Task 1).
- **No tokens in JavaScript.** Cookie mode only: the token source's `get()` returns `''`. There is no `sessionStorage` or `localStorage` token code.
- **Owner writes follow the Board rules that plan 2 proved live:**
  - a new row has `version: 1` and a `writeId`;
  - every edit is a compare-and-set with `version + 1`;
  - a field is cleared with `null` in the store API (BlocksStore sends `''`);
  - every move goes through `assertMove(from, to, 'you')`;
  - every change writes `FactoryEvent` rows with actor `you`.
- Approvals use the current doc version for the gate (`GATE_DOC`: spec→spec, plan→plan, pr→review).
- Hide `GATE-*` tasks everywhere unless "show test tasks" is ticked.
- Release a claim only through the engine. The page never edits `claimBy`/`claimUntil`/`stage`/`attempt`.
- The PR gate cannot open dev/stg/main. The Settings view states this next to the PR gate switch (spec §6).
- No secrets, passwords or tokens in code, logs, tests or commits. The user types passwords themselves. Only `.env.example` is committed; `.env` and `.cert/` are gitignored.
- Commits end with the Co-Authored-By line from the implementer's own harness reminder.

## Review Focus

1. **Bundle safety:** a page build that pulls in a Node-only or secret-holding module must fail a test (Task 1), not ship.
2. **Approval at the right version:** approving after the spec changed must refuse ("the spec changed since you opened it") rather than approve the new version unseen. The Task view sends the version the user was looking at, and the core action checks it against the current version (Task 2).
3. **Concurrent edits with the core:** an owner edit that loses a compare-and-set race to the core shows "the task changed, reload". It is not retried blindly and not reported as saved (Tasks 2, 6).
4. **Session end mid-edit:** a 401 renews once. If renewal is rejected, the page goes to sign-in and keeps the unsent text (approval comment, answer, new-task form) in memory to restore after sign-in (Tasks 4, 6).
5. **Cleared fields:** answering a blocked task, and edits that clear a value, must read back as cleared on the live gateway (BlocksStore's `''` encoding, plan 2 R9). The live check covers it (Task 8).

---

### Task 1: Browser-safe core

**Files:**
- Modify: `core/src/blocks/store.ts`, `core/src/blocks/update.ts`, `core/src/blocks/token.ts`, `core/src/blocks/data.ts`, `core/src/branchGuard.ts`, `core/src/gates.ts`
- Create: `core/src/branches.ts` (pure: `PROTECTED_BRANCHES`, `isProtected`, `branchName`, `ProtectedBranchError`, `assertPushAllowed`). `branchGuard.ts` keeps `HOOK_PATH` and re-exports the rest.
- Create: `core/src/browser.ts` (the browser entry)
- Test: `core/test/browser.test.ts`, extend `core/test/blocks/store.test.ts`

**Interfaces:**
- `TokenSource.invalidate(): void | Promise<void>`. `SdkBlocksData` awaits it before the 401 retry.
- `core/src/browser.ts` re-exports exactly these:
  - `BlocksStore`, `SdkBlocksData`, `type TokenSource`
  - everything from `owner.ts` (Task 2)
  - `assertMove`, `canMove`, `STEP_STATUS`, `TERMINAL`
  - `GATE_DOC`, `resolveSettings`, `resolveGates`, `validApproval`, `shouldMerge`
  - the types, `DEFAULT_SETTINGS`, `MAX_DOC_BYTES`, `PROTECTED_TASK_FIELDS`, `CORE_TASK_FIELDS`
  - `ForbiddenError`, `VersionConflictError`, `NotFoundError`
  - `diffEvents`

**Changes:**
- sha256 uses `@noble/hashes/sha2` `sha256` with `bytesToHex` (sync, same hex).
- `randomUUID` becomes `globalThis.crypto.randomUUID()` (wrapped, so `this` is bound).
- `Buffer.byteLength` becomes `new TextEncoder().encode(s).length`.
- `gates.ts` imports from `branches.ts`.

- [ ] **Step 1: Write the failing tests.**
  - **Golden hash:** `eventId` and `bodySha256` for fixed inputs equal the values the current `node:crypto` code gives. Compute them now and hard-code them.
  - **Bundle:** `browser.test.ts` bundles `src/browser.ts` with esbuild (`platform: 'browser'`, `bundle: true`, `write: false`). It expects success, and its `metafile.inputs` must contain no path matching `/(credential|secrets|wire|cli|git|github|checks)\.ts$|src\/store\.ts$/` and no `node:` import.
  - **Invalidate:** `SdkBlocksData` awaits an async `invalidate()` before retrying. Use a stub whose `invalidate` resolves after a tick and assert ordering.
- [ ] **Step 2: Run.** Expected: FAIL (esbuild reports `node:crypto`/`node:url`). **Step 3: Implement.** Add `@noble/hashes` and `esbuild` (dev). **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(core): browser-safe Blocks store and a browser entry`.

---

### Task 2: Owner actions

**Files:**
- Create: `core/src/owner.ts`
- Modify: `core/src/store.ts` (BoardStore gains `listDocs(taskId, kind): Promise<Doc[]>` and `listRuns(taskId): Promise<Run[]>`; implement them in MemoryStore, FileStore and BlocksStore), `core/test/storeContract.ts`, `core/src/cli.ts` (dev commands call `owner.ts`)
- Test: `core/test/owner.test.ts` (runs on MemoryStore and on `BlocksStore(FakeBlocksData('factory-owner'), 'owner')`), `core/test/cli.test.ts`

**Interfaces** (all take `store: BoardStore` and `now: () => Date` and write events with actor `you`):
- `createTask(store, now, input: {title: string, description: string, repo: RepoId, baseBranch?: string}): Promise<Task>`. It validates a non-empty title and a known repo, and writes a `create` event.
- `markReady(store, now, taskId)` and `cancelTask(store, now, taskId)`. Both use `assertMove(…, 'you')`.
- `answerTask(store, now, taskId, text: string)`. It allows only `blocked`, needs a non-blank `text`, and sets `answer`.
- `decideGate(store, now, taskId, gate: Gate, decision: 'approve'|'changes', seenDocVersion: number, comment: string)`. It refuses unless the task is waiting at that gate (spec_review/spec, plan_review/plan, pr_open/pr). It also refuses with `StaleDocError` when `currentDoc(GATE_DOC[gate]).version !== seenDocVersion`. It writes `addApproval({approvalId: randomUUID(), …})` and one event (`field: 'approval'`, `to: '<gate>:<decision>@v<n>'`).
- `editTask(store, now, taskId, expectedVersion, patch: Partial<Pick<Task,'title'|'description'|'repo'|'baseBranch'|'gateOverrides'>>)`. It is allowed while the status is `inbox` or `ready` only (later, the core is working on it). A lost race throws `VersionConflictError`.
- `saveSettings(store, now, scope: 'global' | RepoId, patch: RepoSettings | Settings)`. It validates `maxParallel` 1–10, `maxTurnsPerStage` 1–500 and `maxCostPerTaskUsd` 0–1000, and writes one event per changed key (`taskId: '-'`, field `settings.<scope>.<key>`).
- Errors: `OwnerActionError(code: 'not-waiting'|'not-blocked'|'not-editable'|'invalid', message)` and `StaleDocError`.

- [ ] **Step 1: Write the failing tests.** For each action:
  - the allowed path, with events checked;
  - each refusal;
  - `decideGate` with a stale `seenDocVersion` → `StaleDocError`;
  - `editTask` racing a core `updateTask` → `VersionConflictError`;
  - `answerTask` then the engine's `sync` resumes the task.

  The existing CLI dev tests keep passing through the new module.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement**, and move the CLI dev logic onto these functions. **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): owner actions shared by the Board and factory dev`.

---

### Task 3 (USER, with executor commands): Sign-in setup for the page

The executor shows each command, runs the ones that need no password or sudo with `--dry-run` first and `--yes` after the user's OK, and records the outputs (never secrets).

1. **App domain** (the user runs this, because it needs a TTY): `cd ~/scratchpad/selise/the-software-factory && blocks new web board-ui --dry-run`. Note the app domain it proposes. The project domain is `https://dfrsgz.slsblx.com`; the app domain is usually a sibling host on `slsblx.com`.
2. **Public client:**

   ```bash
   blocks auth oidc-clients list --json
   blocks auth oidc-clients save --client-display-name "Factory Board (local)" --client-type public \
     --redirect-uris "https://<app-domain>:5173/login/callback" --scope "openid profile" --allowed-scopes openid,profile \
     --require-pkce --use-tokens-cookie --active --register-as-identity-provider --auto-redirect --dry-run --json   # then --yes
   ```

   Then read back: `oidc-clients get <id>` shows `openid` in both scopes, cookie mode and the exact redirect URI. `auth idp list --json` has non-null authorization, token and user-info URLs. `auth config get --json` has `isOidcEnabled: true`, or run `auth config save --oidc-enabled` after a dry run.
3. **Scaffold:** `blocks new web board-ui --app-domain https://<app-domain> --client-id <clientId> --dry-run --json`, then `--yes`. It may change the tenant auth config (isOidcEnabled, activation path); record what changed.
4. **USER (sudo):** add `127.0.0.1 <app-domain host>` to `/etc/hosts`. Optionally trust the generated cert after `npm run cert`.
5. Record the app domain, client id and redirect URI (no secrets) in the vault overview.

- [ ] Steps 1–5 done and recorded. **Commit** the scaffold as generated (with `.env.example`, never `.env`): `chore(board-ui): scaffold with blocks new web`.

---

### Task 4: Sign-in, session renewal and the data client

**Files:**
- Create or modify in `board-ui/src/lib/blocks/`: `config.ts`, `client.ts`, `auth.ts` (ported from ACR `origin/main` `apps/web/src/lib/blocks/auth.ts`, cookie path only: `startLogin`, `completeLogin`, `logout`, `fetchSessionClaims`, `renewSession`, `onSessionExpired`)
- Create or modify: `src/app/providers/AuthProvider.tsx` (5-minute status poll that renews while signed in, a visibility re-check, renew once before treating `auth/me` failure as signed out), `src/app/router/{guards,routes}.tsx`, `src/pages/{Login,Callback,NotOwner}.tsx`
- Create: `src/lib/board.ts`: `cookieTokenSource: TokenSource = {get: async () => '', invalidate: async () => { if (await renewSession() === 'rejected') notifySessionExpired() }}` and `boardStore = new BlocksStore(new SdkBlocksData({apiUrl, projectKey, token: cookieTokenSource}), 'owner')`
- Create: `src/lib/roles.ts`: `isFactoryOwner(me: unknown): boolean`, which fails closed (`data.roles` must be an array of strings that includes `factory-owner`)
- Test: `board-ui/src/**/*.test.ts(x)` (vitest + jsdom, with the SDK and fetch mocked)

- [ ] **Step 1: Write the failing tests.**
  - The renewal path: `renewSession` maps 200 to `renewed`, a 400 with `error` to `rejected`, and a network error to `unavailable`. `unavailable` never signs out. Only one renewal is in flight at a time.
  - `RequireAuth` redirects an unauthenticated user to `/login?returnTo=…`.
  - The callback runs once.
  - `isFactoryOwner` returns false for a missing role, an odd shape or a non-array.
  - A signed-in user without the role sees the `NotOwner` page, with the message "This account doesn't have the factory-owner role."
- [ ] **Step 2: Run** `cd board-ui && npx vitest run`. Expected: FAIL. **Step 3: Implement.** Point `board-ui/package.json` at `../core/src/browser.ts` through a Vite alias `@factory/core`. Mark ACR origins in comments where code is ported. **Step 4: Run** `npx vitest run && npx tsc --noEmit && npx vite build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(board-ui): hosted sign-in with session renewal and the Board data client`.

---

### Task 5: Design contract and app shell

**Files:**
- Create: `board-ui/src/app/AppShell.tsx` (top bar with the project name, the views Board/History/Settings, a pause indicator, the user, and sign out), `board-ui/src/app/board.css` (tokens with a light and dark theme)
- Test: an AppShell render test, plus a CSS-clash guard test

**Design contract** (use the frontend-design skill for the visual direction within these rules):
- The page is calm and dense, built for one person checking a queue several times a day.
- Status columns use one neutral palette. Colour is reserved for the states that need you, `spec_review`/`plan_review`/`pr_open`/`blocked`, which get one accent, and for `done` and `cancelled`, which are muted.
- System font stack. 14px base. Monospace for ids, branches, versions and costs.
- Light and dark follow `prefers-color-scheme`.
- Everything is reachable by keyboard, with a visible focus ring. Every control has a text label, not just an icon.
- The page works at 1024px width and above, which is enough for local desktop use. Below that, columns stack vertically.
- Avoid the scaffold CSS clashes from the research note §5: no `.grid`/`.outline` class names, and no bare `aside` styling.

- [ ] **Step 1: Write the failing tests.**
  - AppShell renders the three views and sign out, and shows "Factory paused" when `settings.paused`.
  - The guard test fails if `board.css` defines `.grid`, `.outline` or a bare `aside` selector.
- [ ] **Step 2–4:** red, implement, green, then `npx vite build`.
- [ ] **Step 5: Commit** `feat(board-ui): app shell and design tokens`.

---

### Task 6: Board and Task views

**Files:**
- Create in `board-ui/src/features/board/`: `useBoard.ts` (`useQuery(['board','tasks'], () => boardStore.listTasks())`, refetching every 30 s), `BoardView.tsx` (a column per status in spec §5 order, a repo filter, a "show test tasks" toggle, and a New task form with title, description, repo and an optional base branch that defaults to `dev`), `TaskCard.tsx`
- Create in `board-ui/src/features/task/`: `useTask.ts` (task, current and listed docs per kind, approvals, runs, events), `TaskView.tsx`, `DocVersions.tsx` (a version picker and a line diff between two versions, using `diff`), `GatePanel.tsx` (Approve / Request changes with a comment, sending `seenDocVersion`), `AnswerPanel.tsx`, `TaskActions.tsx` (Mark ready, Cancel, Edit while inbox/ready)
- Create: `board-ui/src/lib/unsent.ts` (keeps unsent form text in memory across a session end, ported from ACR `unsent-text.tsx`)
- Test: a component test for each, with `boardStore` mocked or with `BlocksStore(FakeBlocksData('factory-owner'))` from core

**Behaviour:**
- **Columns:** `inbox`, `ready`, `spec`, `spec_review`, `plan`, `plan_review`, `build`, `verify`, `review`, `pr_open`, `done`, `blocked`, `cancelled`. Done and Cancelled are collapsed by default and show their counts.
- **Card:** the task id, title, repo, stage, and a "waiting for you" badge on review states and Blocked. A Blocked card shows the first line of its question.
- **Task view sections, in order:** header (title, repo, base, branch, a PR link that opens in a new tab, status, stage, attempt, cost), description, spec and plan (current version, with the picker and diff), verify and review reports, the gate panel when waiting at a gate, the answer panel when blocked, runs (step, agent, mode, start/end, turns, cost, result), and history (the task's events, newest first).
- **Writes** go through `owner.ts` actions, with the outcomes below. Every success invalidates the board and task queries.

| Outcome | What the page shows |
|---|---|
| `VersionConflictError` | "This task changed while you were looking. Reload to see the latest." with a Reload button, keeping your text |
| `StaleDocError` | "The spec changed since you opened it (now v<n>). Review the new version first." The diff to the new version is shown |
| `OwnerActionError` | Its message |
| `ForbiddenError` | "Blocks refused this change for your account." |
| Session ended | The text is kept (`unsent.ts`) and you're sent to sign in |

- [ ] **Step 1: Write the failing tests.**
  - The columns render in order. `GATE-*` tasks are hidden until toggled.
  - The New task form calls `createTask` and the new card appears.
  - Approve sends the version shown, and a stale version shows the stale message with the diff.
  - A conflict keeps the comment text.
  - The Answer panel shows only when blocked, and needs non-blank text.
  - Cancel asks for confirmation.
  - The diff shows added and removed lines.
- [ ] **Step 2–4:** red, implement, green, then `npx vite build`.
- [ ] **Step 5: Commit** `feat(board-ui): Board and Task views`.

---

### Task 7: History and Settings views

**Files:**
- Create: `board-ui/src/features/history/{useHistory.ts,HistoryView.tsx}`. It reads events per task: for each non-test task, `listEvents(taskId)`, plus the settings events (`listEvents('-')`), merged and sorted newest first. It never calls an unfiltered `listEvents()`, because of the list page cap. It has filters for actor (you / spec-writer / planner / implementer / verifier / reviewer / core), mode, task and date range. Rows show the time, actor, task, field, from → to and reason.
- Create: `board-ui/src/features/settings/{useSettings.ts,SettingsView.tsx}`. It shows global gates spec/plan/pr, per-repo overrides (inherit / on / off per gate for each of the 7 repos), max parallel, turn limit, cost limit and the Pause factory switch. Save goes through `saveSettings`, with each scope saved separately. Next to the PR gate it shows: "Turning this off lets the factory merge into other branches. A PR into dev, stg or main always waits for you."
- Test: component tests

- [ ] **Step 1: Write the failing tests.**
  - The filters narrow the rows.
  - Events from several tasks merge in time order.
  - Settings validation messages appear (for example, max parallel 0 is refused).
  - Saving a repo override writes only that scope.
  - The pause switch saves and the shell shows "Factory paused".
  - The PR-gate note is visible.
- [ ] **Step 2–4:** red, implement, green, then `npx vite build`.
- [ ] **Step 5: Commit** `feat(board-ui): History and Settings views`.

---

### Task 8 (USER live check): The page against the real Board

The user runs `cd board-ui && npm run cert && npm run dev` (if the cert isn't trusted, accept the warning once) and opens `https://<app-domain>:5173` in a normal browser, not the desktop app's built-in one. The executor watches `factory --store blocks status --json` and the Blocks rows between steps.

- [ ] **1.** Sign in as `klr.lakit@yopmail.com`. The Board loads, and the `GATE-*` tasks are hidden.
- [ ] **2.** Create the task "Board check" on repo `data`. The core (`factory --store blocks status --json`) sees it as `inbox`, with a `create` event whose actor is `you`.
- [ ] **3.** Mark it ready, then cancel it. The status changes and the events are visible in History.
- [ ] **4.** Settings: turn on Pause and save. `factory --store blocks status --json` shows `paused: true`. Turn it off again.
- [ ] **5.** Leave the page open more than 20 minutes and click something. It still works without signing in again, which shows the renewal works.
- [ ] **6.** The user creates the task "Answer check" on the page. The core can't insert tasks, so the executor then moves it to `blocked` with a one-off script as the factory core (`status: 'blocked'`, `stage: 'build'`, `question: 'check question'`). The user answers it on the page, and the core sees `answer` set. The executor runs `Engine.sync()` through the script: the task resumes at `build` with the question and blocked reason cleared, which proves the `''` clearing again. The user cancels it on the page straight away, so no runner picks it up.
- [ ] **7.** Record the results in the vault overview. On any failure, fix it and repeat the step.
