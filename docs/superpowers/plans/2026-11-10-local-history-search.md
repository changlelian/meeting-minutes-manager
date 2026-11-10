# Local History Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-memory search to the local history dialog without changing persistence or current-draft behavior.

**Architecture:** Extend the existing inline history UI with one semantic search control. Keep `historyQuery` only in client state; derive the visible records inside `renderHistory()` and reuse the existing history-detail renderer.

**Tech Stack:** HTML, inline CSS, browser-native JavaScript, Node.js built-in test runner, headless Chrome CDP tests.

**Spec:** `docs/superpowers/specs/2026-11-10-local-history-search-design.md`

## Global Constraints

- Keep history local to `meeting-demo.history.v1`; do not add a backend endpoint or cloud operation.
- Search only topic and transcript content; do not mutate stored records, minutes, or the active meeting draft.
- Keep the quiet-editorial history dialog styling, keyboard focus, and existing IDs/test contracts intact.

## Review Focus

- No match must not erase a remembered selection or persist a search term.
- Clearing search restores the unfiltered list and selected record.
- Search must never request a network route or change `localStorage` content.
- The new input must be labelled and control the history list accessibly.
- Existing history sorting and 20-record cap remain intact.

---

### Task 1: In-Memory Local History Filter

**Files:**
- Modify: `tests/meeting-demo.browser.test.mjs`
- Modify: `index.html:history dialog markup, inline history CSS, and renderHistory controller`

**Interfaces:**
- Consumes: `state.history`, `state.selectedHistoryId`, `renderHistory()`, `#history-list`, and `meeting-demo.history.v1`.
- Produces: `#history-filter`, transient `state.historyQuery`, and filtered list/detail output with no persistence side effect.

- [x] **Step 1: Write the failing browser regression**

Add `test('filters local history without changing storage or the active draft', ...)`. Seed three valid records directly in localStorage, set an unsaved active transcript, then assert topic/transcript filtering, no-match state, result count, restored list after clearing, unchanged storage bytes, and unchanged active draft.

- [x] **Step 2: Verify RED**

Run: `node --test --test-name-pattern="filters local history" tests/meeting-demo.browser.test.mjs`

Expected: FAIL because `#history-filter` does not exist.

- [x] **Step 3: Implement transient filtering**

Add a labelled search input and quiet-editorial styles. Add `historyQuery` state and derive visible records from normalized topic/transcript text in `renderHistory()`; update list status and no-match detail without calling `persistHistory()`.

- [x] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern="filters local history" tests/meeting-demo.browser.test.mjs`

Expected: PASS.

- [x] **Step 5: Verify complete behavior**

Run: `npm test`

Expected: all tests pass.
