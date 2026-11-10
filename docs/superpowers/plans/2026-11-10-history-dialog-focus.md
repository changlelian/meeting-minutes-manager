# History Dialog Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give keyboard users a predictable search-first, return-to-trigger focus flow for the local-history dialog.

**Architecture:** Keep the existing native `<dialog>` and history state. The history-button listener will focus the existing filter after opening; a close listener will return focus to the trigger. A narrow keydown handler on the populated filter converts only non-composing Escape presses into a dialog close, preserving the current query.

**Tech Stack:** Static HTML/vanilla JavaScript; Node.js built-in test runner; Chrome DevTools Protocol browser tests.

**Spec:** `docs/superpowers/specs/2026-11-10-history-dialog-focus-design.md`

## Global Constraints

- Do not alter history records, local-storage keys, draft state, recording, API configuration, or provider calls.
- Preserve filter text and selected history state across dialog close/reopen.
- Intercept Escape only for a populated `#history-filter` when `event.isComposing` is false.
- Focus restoration must run from the history dialog `close` lifecycle so button, Escape, and programmatic close share the same result.
- The workspace is not a Git repository; use direct tests and a per-plan ledger instead of commits or diff ranges.

## Review Focus

- Opening from an unrelated focused control must move focus to the search input (Task 1 browser regression).
- A populated filter’s first Escape must close rather than clear the query (Task 1 browser regression).
- Close returns focus to the trigger and leaves active meeting inputs unchanged (Task 1 browser regression).
- Reopening preserves the query and selected matching record, while refocusing the filter (Task 1 browser regression).
- IME composition and other dialogs remain untouched by the narrow handler (source/behavior review in Task 1).

---

### Task 1: History Dialog Focus Lifecycle

**Files:**
- Modify: `index.html:648-649` — focus the existing filter after history dialog opening, close a populated non-composing filter on Escape, and restore focus on dialog close.
- Modify: `tests/meeting-demo.browser.test.mjs:190-213` — add a Chrome keyboard regression for opening, filtering, closing, and reopening.

**Interfaces:**
- Consumes: `#history-button`, `#history-dialog`, `#history-filter`, existing `state.historyQuery`, `renderHistory()`, and native dialog `close` behavior.
- Produces: predictable active-element behavior only; no new application API or stored data.

- [x] **Step 1: Write the failing browser regression**

  Add a test that first focuses `#meeting-topic`, opens history through the actual history button, and expects `#history-filter` to be active. Type literal `新用户`, dispatch the real input event, send one Chrome Escape keypress, then assert the dialog is closed, focus is on `#history-button`, topic/transcript are unchanged, and reopening retains the query, matching selected record, and filter focus.

- [x] **Step 2: Run focused test to verify it fails**

  Run: `node --test --test-name-pattern="history dialog search" tests/meeting-demo.browser.test.mjs`

  Expected: FAIL because the current dialog initially focuses another control and Escape clears populated search rather than closing.

- [x] **Step 3: Implement the minimal focus lifecycle**

  After `showModal()`, call `elements.historyFilter.focus()`. Add a filter-only `keydown` handler that prevents default and calls `historyDialog.close()` only for populated, non-composing Escape. Add a history-dialog `close` handler that restores focus to `historyButton` once the dialog is closed.

- [x] **Step 4: Run focused test to verify it passes**

  Run: `node --test --test-name-pattern="history dialog search" tests/meeting-demo.browser.test.mjs`

  Expected: PASS.

- [x] **Step 5: Run the full suite**

  Run: `npm test`

  Expected: all server, browser, and helper tests pass with no failures.

- [x] **Step 6: Record verification**

  Record RED/GREEN/full-suite results and every scope ruling in `.superpowers/sdd/2026-11-10-history-dialog-focus/progress.md`; no Git commit is possible in this workspace.

## Self-Review

- Spec coverage: Task 1 tests initial focus, populated Escape, focus return, state preservation, and reopening.
- Step scan: each step is a single test, verification, implementation, or recordable result.
- Type consistency: all touched DOM IDs and history state already exist; no new stored schema or API is introduced.
- Review focus: the user-visible keyboard path is covered in one real-browser flow; composition isolation is constrained in production code.
- Proportion: this is a small event-listener and browser-regression addition with no dependency or backend change.
