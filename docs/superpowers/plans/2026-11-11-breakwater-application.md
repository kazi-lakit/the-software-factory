# Breakwater Application Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign every frontend component around the supplied Breakwater direction and the application's decision workflows.

**Architecture:** Keep current routes, data stores and feature components. Rework shell and page structures; replace conflicting style overrides with canonical component recipes. Use a temporary local sample-data preview of actual screens for visual verification.

**Tech Stack:** React 18, TypeScript, Vite, existing Lucide icons, CSS, Vitest.

**Spec:** docs/superpowers/specs/2026-11-11-breakwater-application-design.md

## Global constraints

Preserve authorization, stale approval checks, drafts, keyboard navigation and phone action bars. No new runtime dependencies. Use Instrument Serif, DM Mono, square geometry and 220ms restrained transitions.

## Review focus

Long titles and answer explanations; dense history rows; empty and filtered boards; save/error/conflict states; phone overflow and focus.

## Tasks

- [x] Study each screen, document scope and set up a local preview using the existing in-memory store.
- [x] Rebuild shell and board hierarchy; add focused tests for summary and reset behavior.
- [x] Redesign shared controls, cards, tables, tabs, forms, dialogs and states in the canonical stylesheet.
- [x] Improve task decisions, history scanning and settings feedback; cover behavior changes with tests.
- [x] Verify actual screens at desktop/mobile in both themes, review against the reference, run all checks and report limitations.

## Verification and rulings

- Used real screens over a temporary in-memory BlocksStore preview; removed that harness from the delivered source.
- Inspected populated board, spec review, answer options, history, settings, task creation, factory setup and landing. Verified 390px phone, 1024px tablet and desktop layouts, plus light and dark modes. No page-wide horizontal overflow at inspected board widths.
- Ruling: replace obsolete tests specifying the retired brand's exact padding, fonts and geometry with focused design usability invariants; preserve behavior, contrast, CSS collision, mobile specificity and keyboard tests. The user explicitly authorized replacing the former guideline.
- Independent review found missing accessible names on tablet icon navigation and a stale table-padding override; both corrected.
- Visual dark-mode verification caught incorrect premultiplied shader alpha; corrected to preserve the actual ink/mist surfaces.
- Build and TypeScript pass. Full test suite passes. Production bundle keeps the existing over-500kB build warning; no dependencies added.
