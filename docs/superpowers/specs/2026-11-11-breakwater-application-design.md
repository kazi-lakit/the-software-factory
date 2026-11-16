# Breakwater application redesign

The previous pass changed fonts, colours, and a decorative field, but left the old component hierarchy intact. The user explicitly requests a full frontend redesign and better UX, based on the supplied BREAKWATER design document.

## Application study

The owner moves tasks through Spec → Plan → Build → Verify → Review → PR. Spec, plan, PR and blocked questions can require a decision. The board has five lanes and an optional detailed status view; filters persist factory and view choices. Task pages contain versioned documents, approval forms, answer choices, execution records and contextual details. History combines time, actor, task, change and reason with filters. Settings manages immediate pause, separately saved gates and limits, repository overrides, factory definitions and repository forms. New task and factory forms already protect drafts and validate data; preserve that behavior.

Current UX defects: decorative board introduction duplicates the page title; all filters and primary actions share one undifferentiated toolbar; hollow small controls have insufficient hierarchy; empty columns look unfinished; table rows lack clear scanning structure; long answers and change descriptions are truncated; success feedback is visually hidden; settings section boundaries are weak. The first pass also stacked new declarations over old ones, leaving conflicting styles.

## Direction and constraints

Use the existing React/Vite application, routes and data hooks. No new design framework or network dependency. Keep every authorization, stale-document check, draft behavior, keyboard interaction and responsive mobile action bar.

Palette: mist #EEF2F3, surface #F8FAFB, ink #0C1114, muted #526571, harbour #4693C3 (accessible text variant #245F86), violet #5247CD. Dark mode uses ink surfaces with pale text. Instrument Serif is display; DM Mono is body/control typography. Square panels, 4px spacing rhythm, 220ms restrained motion. The background supports the interface; content surfaces remain legible.

## Approach

A token-only restyle repeats the earlier failure. A wholesale frontend replacement would endanger mature workflows. The chosen implementation changes the existing shell and screen markup plus the shared component stylesheet in place: a visible navigation system, meaningful board heading and queue summary, separated search/filter toolbar, substantial task cards, consistent button hierarchy, readable tabular data, grouped forms and focused decision panels.

## Component and screen coverage

- Shell: dark vertical desktop navigation with icons and current location; compact mobile header and accessible bottom navigation; workspace context, account and theme controls; skip link.
- Board: one title, short purpose copy, primary New task action, counts from current filters, search/filter area, labelled lanes with clear empty states and semantic status treatments.
- Task: serif title, segmented progress, distinct decision area, readable document, clear approve/request-change buttons, complete answer explanations, metadata sidebar, tabs and run/history tables.
- History: purpose heading, filter panel, category tabs, visible result count, clear table head, readable full changes and reasons, reset filters on no matches.
- Forms: consistent labels, field grouping, comfortable controls, helpful placeholders, clear validation/focus, divided submit footer, summary side panels.
- Settings: clear section navigation and scope, panel headings and descriptions, switches in readable rows, repo override tables and inline feedback visible after save.
- Landing/system/profile: same typography, surface and control recipes, a clear sign-in path, helpful empty/error/loading states.

## Verification

Exercise the actual signed-in components with local in-memory sample tasks, factories, documents and events. Visually inspect board, task decision, history, settings and creation screens at desktop and phone widths, plus both themes. Use existing behavior tests, add focused tests for new filter/reset/count behavior, update obsolete styling assertions, and preserve contrast/accessibility tests. Run typecheck, build, full test suite, diff review. Do not claim signed-in visual verification from the landing screen.
