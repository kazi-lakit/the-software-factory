# Manage factories UX proposal

Status: proposed for review. Planning only; no application changes or deployment.

## Goal
Make factories and repository definitions easy to scan and edit on phones and desktops.

## Current findings
`FactoriesTab.tsx` renders all factory metadata and all repositories together. A single `editing` state swaps forms, so starting another edit can discard the current form. Repository editors sit after the entire repository list. The per-factory Settings selector remains above Manage factories although this section manages every factory.

## Recommended design
Use a compact list of expandable factory cards. This scales from one factory to several while retaining the existing Settings route. A separate management page adds unnecessary navigation; a dense table is harder to use on phones.

- Make global scope explicit: “Manage all factories”. Hide the execution-settings factory selector in this tab, preserving its selection for the other tabs.
- Top actions: primary “Add factory”, secondary “Import factory”. Show the factory count. Add name/id search when there are multiple factories; show matching count and Clear search.
- Each collapsed factory card shows name, factory id, Active/Inactive definition status, repository count, and GitHub sign-in status. Distinguish Active from the execution pause setting; explain that pause/resume lives in General.
- Expand one factory at a time. Initially expand the sole factory, or the currently selected factory when several exist; otherwise leave the list collapsed. Keep expansion predictable after saves.
- Expanded content has two clear sections: Factory details and Repositories. Put protected branches, GitHub account/check time and model configuration in labelled rows. Show unknown health distinctly from signed out.
- Give actions explicit names: Edit factory, Add repository, Edit repository. Put the repository editor directly below its own row; put a new-repository form before the list.
- Repository summaries show id, base branch and a readable remote link. Long URLs wrap; editing preserves the exact stored remote. Avoid raw configuration dominating summaries.
- Group factory editing into Identity, Protected branches, and Agent models. Retain immutable IDs, validation, authorization and version-conflict handling.
- Preserve repository checks JSON and the existing change review/Confirm change flow. Group repository identity/remote/base separately from check commands; provide concise field guidance.
- Only one editor is active. Warn before closing, switching factory/repository, importing, or navigating away with dirty edits. Cancel retains no changes; successful saves return focus to the initiating action and show local feedback.
- Empty, filtered-empty, loading, refresh-failed, invalid-definition and save-conflict states explain what happened and offer a relevant recovery action. Keep invalid definitions in a separate disclosure.

## Implementation sequence
1. Update `SettingsView.tsx` global scope presentation and preserve the selected execution factory when changing tabs.
2. Reshape `FactoriesTab.tsx` into summary cards and expandable detail sections; add scoped search and explicit action labels.
3. Reposition `FactoryForm.tsx`, `RepoForm.tsx` and `ImportFactory.tsx` flows; add dirty-edit guards and focus restoration without changing write operations.
4. Update existing factories/import/router tests and add behavior checks for expansion, search, editor switching, cancel/save/conflict handling and protected checks confirmation.
5. Review populated screens in both themes at 320, 390, 768 and 1440 pixels with zero, one and several factories, long names/remotes and many repositories. Verify keyboard operation, 44px phone actions, draft guards and no page-wide overflow.

## Completion criteria
All existing add/edit/import capabilities remain available; the active edit and its factory/repository are unmistakable; no dirty draft is silently discarded; mobile users can reach a repository editor without scrolling past unrelated repositories. TypeScript, production build and relevant behavior/contrast suites pass. Capture review evidence before deployment.
