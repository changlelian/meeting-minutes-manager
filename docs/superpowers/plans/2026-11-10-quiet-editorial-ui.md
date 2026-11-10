# Quiet Editorial Meeting Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the existing meeting-minutes page into a quieter, more premium desktop workspace while retaining every recording, Qwen, export, and local-history behavior.

**Architecture:** Keep the dependency-free single-page architecture and all JavaScript behavior intact. Replace the inline CSS visual token layer and adjust only presentation markup needed for an explicit local-only history disclosure; use the browser suite to protect the existing interaction contracts and assert the new accessibility-facing visual affordances.

**Tech Stack:** HTML, inline CSS, browser-native JavaScript, Node.js built-in test runner, headless Chrome CDP tests.

**Spec:** `docs/superpowers/specs/2026-11-10-quiet-editorial-ui-design.md`

## Global Constraints

- Keep all existing element `id` values, `data-testid` values, button text, ARIA roles, and meeting behavior unchanged.
- History records remain only in browser `localStorage` under `meeting-demo.history.v1`; add no backend history API, cloud sync, account, or deletion UI.
- Use the approved quiet-editorial palette: warm paper, subtle pale-green ambience, low-contrast cards, forest-green primary action, and restrained shadows.
- Preserve keyboard focus styling, textual state descriptions, responsive breakpoints, and `prefers-reduced-motion` handling.
- This directory is not a Git repository; do not create commits or worktrees.

## Review Focus

- Keyboard and touch interaction: primary, secondary, and icon controls remain at least 40 CSS pixels high without losing accessible names.
- Local-only promise: the history dialog visibly explains that records remain in the current browser and the footer still states that no upload occurs.
- Narrow viewport: the history dialog is bounded to the viewport and its panes can scroll instead of overflowing.
- Regression boundary: existing test IDs, dialog controls, and client-side storage key remain unchanged.
- Visual contrast: status and error text remains present alongside the new color treatments.

---

### Task 1: Quiet Editorial Visual Shell

**Files:**
- Modify: `tests/meeting-demo.browser.test.mjs`
- Modify: `index.html:8-161`

**Interfaces:**
- Consumes: Existing `#history-dialog`, `#history-button`, `.record-primary`, `.secondary-button`, `.icon-button`, `.app-shell`, and `.history-dialog-content` DOM/CSS contracts.
- Produces: A responsive quiet-editorial visual system and `#history-local-note` disclosure while preserving the existing client controller and test selectors.

- [x] **Step 1: Write the failing browser test**

Add `test('presents local-only history in an accessible, viewport-safe workspace', ...)` to query the real rendered page. Assert that `#history-local-note` includes `仅保存在当前浏览器`, the footer still says `不会上传`, primary/history/settings controls are at least 40 CSS pixels high, and the history dialog has a bounded `max-height` after it opens.

- [x] **Step 2: Run the targeted test to verify it fails**

Run: `node --test --test-name-pattern="presents local-only history" tests/meeting-demo.browser.test.mjs`

Expected: FAIL because the local-only disclosure element and 40-pixel control sizing do not yet exist.

- [x] **Step 3: Implement the visual refresh in `index.html`**

Update the inline CSS tokens and selectors to remove the visible grid texture, introduce the subtle ambient background, 14–18px cards, 9–12px controls, low-contrast borders, small shadows, and more spacious panel/dialog rhythm. Add the noninteractive `#history-local-note` text to the existing history dialog header; do not alter controller JavaScript or persistence behavior.

- [x] **Step 4: Run the targeted browser test to verify it passes**

Run: `node --test --test-name-pattern="presents local-only history" tests/meeting-demo.browser.test.mjs`

Expected: PASS.

- [x] **Step 5: Run the relevant browser suite**

Run: `node --test tests/meeting-demo.browser.test.mjs`

Expected: all browser interaction and persistence tests pass.

- [x] **Step 6: Record task completion without a commit**

Record the test evidence in this plan's SDD ledger. The workspace is not a Git repository, so no commit is created.

## Plan Self-Review

- The only changed application surface is the requested visual layer and local-history disclosure; recording, Qwen, export, and server integration are explicitly kept untouched.
- The test targets observable user-facing outcomes rather than source strings: local-only disclosure, no-upload footer copy, interactive target height, and viewport-safe history modal.
- The sole task owns every spec requirement and its direct browser verification, so no cross-task interface ambiguity remains.
