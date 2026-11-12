# Workspace UX Improvements Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans after the user approves this plan. This document authorizes no implementation or deployment by itself.

**Goal:** Make factory configuration easier to understand, put task content in the requested order, clarify questions and choices, and move the kanban closer to the top of the board.

**Architecture:** Retain existing React routes, data hooks and write operations. Reorganize feature components and apply scoped layout changes within the existing Breakwater design system. Changes are planned in four independently verifiable tasks.

**Tech Stack:** React, TypeScript, existing CSS, TanStack Query, Vitest, browser verification.

**Spec:** The user's four requested UX changes in this chat, plus the existing Breakwater visual direction. This plan is proposed for approval.

## Global constraints

- Exact task-tab order: Description → Spec → Plan → Q&A → Checks → Review → Runs → History.
- Description is selected when opening a task. A pending question or review must still be discoverable immediately.
- Preserve draft text, selected answer, stale-document protection, version conflicts, authorization and current save behavior.
- Preserve the single unboxed theme icon; support light/dark modes and 320px phones upward.
- Keep typography, palette, flat surfaces and square geometry from the current Breakwater direction.
- No new runtime dependencies or backend schema changes.

## Findings from the current application

- `SettingsView` renders Factory, Gates and limits, Repos and Factories simultaneously, with anchor navigation. On phones this creates a long page; factory selection is visually distant from several editing scopes.
- `TaskView` defaults to History, keeps Description in the sidebar, and renders `AnswerPanel`, `EarlierQuestions` and `QaLog` outside its tabs. The result repeats Q&A information and forces extra scrolling.
- `AnswerPanel` already parses options and recommendations, but the question is visually secondary to surrounding metadata. `QaLog` has enough data to display prior options and chosen answers.
- `BoardView` stacks a large heading, four count blocks, a separate filters surface, a result/status strip and phone lane selectors before cards begin.

## Proposed UX

### 1. Factory settings

- Replace the long anchor-driven page with four section tabs: General, Gates & limits, Repositories, Manage factories.
- Keep the selected factory in a compact scope bar immediately above the scoped sections. Always show which factory is being edited; show its running/paused state in General.
- Avoid the current ambiguous All factories selection for editable per-factory settings. Resolve a valid selected factory, defaulting to the first available factory when necessary. Manage factories remains an explicitly global section.
- General: factory name and state, a clearly labelled pause/resume control, and concise explanation of when it takes effect.
- Gates & limits: group approval switches together; group numeric limits together; show field errors beside their fields and success/error feedback beside the save action.
- Repositories: show compact repository summaries and explicit Inherited/Overridden state. Edit one repository's overrides at a time; stack editable controls on phones rather than squeezing them into table cells.
- Manage factories: retain existing add, edit, import and repository-definition actions, grouped by factory. Distinguish these definitions from per-factory execution overrides.
- Keep current save boundaries: pause saves immediately; gates/limits and each repo override save explicitly. Label that difference.
- Preserve unsaved edits when changing section tabs. On a factory change, guard against silently applying or losing another factory's unsaved edits.
- Support existing `/settings#settings-*` links by mapping the fragment to the corresponding tab. New factory creation/back links continue to work.

### 2. Task details and tab order

- Render the task heading and compact status/progress summary, followed immediately by the tabs.
- Use exactly: Description, Spec, Plan, Q&A, Checks, Review, Runs, History.
- Move the full description into the first tab; remove the duplicate sidebar description. Keep operational metadata in the Details sidebar/disclosure.
- Show concise pending-action notices above the tabs: e.g. “Your answer is needed” with “View question”, or “Spec approval needed” with “Review spec”. Each action selects and focuses the relevant tab/panel.
- Keep approval controls with the relevant Spec, Plan or Review content, rather than placing a large decision document above every tab. Preserve protected-branch PR instructions and stale-version checks. PR approval/merge information belongs to Review because the requested order has no PR tab.
- Empty tabs explain what has not been produced yet. Tab labels may include useful counts without changing their order.
- Add an optional controlled selection to `TaskTabs`, retaining its current uncontrolled behavior for other callers. Pending-action links use it to select a tab.
- Add per-tab `keepMounted` support where forms need draft preservation. Hidden panels must not expose interactive controls or fixed action bars. Use it for Q&A and any approval panel with unsent comments.

### 3. Q&A information and actions

- Create one Q&A tab containing the active question first, followed by earlier questions. Remove the duplicate outside-tab Q&A panels.
- Highlight the question itself in a blue-tinted question block, with a clear “Waiting for your answer” state. Put asker/time/reason in a secondary metadata line.
- Place all answer options directly under that question. Each option shows its letter, short title and full explanation; a Recommended badge stays attached to the recommended option.
- Keep the selected option distinct from the recommendation. A recommendation is advice, while “Selected” or “Your answer” communicates the user's actual choice.
- Preserve the existing initial recommended selection behavior. Nothing is submitted until Send answer is pressed.
- Keep Other/free-text answers available, with clear validation and confirmation after sending. Preserve choice and draft while switching task tabs.
- For earlier questions, show the question, offered options, Recommended tag, recorded answer and who/when answered together. Collapse older entries with a meaningful question summary; do not reduce their content to only a timestamp.
- Handle plain-text questions, questions without recommendations, long explanations, and absent/malformed option formatting using existing parsing fallbacks.

### 4. Compact board controls

- Remove the decorative eyebrow/tagline from the operational board heading. Use a compact row with Board, factory context and New task.
- Replace the tall four-card count summary with a short inline count strip. On phones, use counts already shown in lane pills instead of duplicating them in a separate summary grid.
- Desktop: put search, repository filter, lane/stage switch and a More filters control in one compact toolbar where space permits. Put test-task visibility in More filters.
- Phone: search plus Filters/view controls in a compact block; additional filters expand on request. Keep an active-filter indicator and an obvious reset action.
- Fold the task-result count into the toolbar; remove the dedicated refresh-message row. Keep stale/error feedback when data cannot refresh.
- Keep lane-level counts and existing task ordering. Changing filters must update the visible results and counts consistently.
- Target at 390×844: the first task card begins within roughly the top 400 CSS pixels when filters are collapsed and the lane has tasks. At 1440×900: lane headers begin within roughly the top 260 CSS pixels. Measure actual layout; treat long error messages and expanded filters as justified exceptions.

## Implementation tasks

### Task A — Compact factory settings

**Files:** `features/settings/SettingsView.tsx`, `FactoriesTab.tsx`, associated tests, scoped rules in `app/board.css`; `TaskTabs.tsx` only for reusable state-preserving section navigation.

- [ ] Add failing behavior tests for active section, valid factory scope, legacy fragment links, drafts across section switches and guarded factory changes.
- [ ] Implement the four sections and compact scope bar, preserving existing save operations.
- [ ] Reorganize repository override editing for phone layouts and local feedback.
- [ ] Verify two factories with long names, no factories, load failures, save conflicts and validation errors.

### Task B — Consolidate and clarify Q&A

**Files:** `features/task/AnswerPanel.tsx`, `QaLog.tsx`, `qaEntries.ts` only if display data is missing, and their tests; scoped question/option CSS.

- [ ] Add failing tests for question prominence/association, recommended versus chosen options, historical options and free-text fallback.
- [ ] Implement the grouped question/options/answer presentation using existing parsed data.
- [ ] Verify long explanations wrap, radio labels are keyboard operable, and recommendations are not communicated by colour alone.

### Task C — Reorder task details

**Files:** `features/task/TaskView.tsx`, `TaskTabs.tsx`, `GatePanel.tsx` only as required for placement, task/router tests and scoped CSS.

- [ ] Add failing tests for the exact eight-tab order and Description as the initial panel.
- [ ] Implement controlled tab selection and per-tab state preservation with accessible hidden panels.
- [ ] Move description, Q&A and relevant decision panels into their tabs; remove duplicate rendered information.
- [ ] Add pending-action links and verify they select/focus the correct panel.
- [ ] Test unsent answers/comments across tab changes, sending an answer, stale approvals, protected PRs and history availability.

### Task D — Recover kanban space

**Files:** `features/board/BoardView.tsx`, its tests and scoped board CSS.

- [ ] Retain count/filter behavior tests and add cases for active-filter indication and reset.
- [ ] Replace tall counts and redundant heading/status rows with the compact arrangement above.
- [ ] Verify both lane and all-stage modes, empty results, many tasks and expanded filters.
- [ ] Measure the first-card/lane-header position at the target viewport sizes and compare against the current layout.

## Review focus

- Factory switch with unsaved edits: never save a draft against the wrong factory.
- Hidden task panels: no focusable controls, duplicate IDs or fixed action bars from inactive tabs.
- Answer and approval drafts: preserve them through tab switching and retain conflict handling.
- Pending decisions: discoverable from Description without automatically overriding the requested default tab.
- Long factory names, descriptions, branch names and answer explanations: no page-wide horizontal overflow.

## Final verification

- [ ] Run TypeScript, production build and the full behavior/contrast test suite.
- [ ] Review the actual populated screens in light and dark themes at 320, 390, 768 and 1440 CSS pixels.
- [ ] Use at least two factories, including a long name, so the selector is actually present.
- [ ] Verify Settings tabs/overrides, Description default, unanswered and answered Q&A, spec approval and board lane/stage modes.
- [ ] Check keyboard tab navigation, visible focus, 44px phone actions and absence of page-wide overflow.
- [ ] Produce before/after screenshots and the measured board vertical-space reduction.
- [ ] Present the completed changes and validation. Deployment follows the user's approval of this plan and implementation authorization.

## Approval status

Proposed only. No application source changes, commits, pushes or deployments are part of this planning step.
