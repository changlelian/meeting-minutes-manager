# Historical Markdown Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user download the locally displayed history record as UTF-8 Markdown without touching their active meeting draft or stored history.

**Architecture:** Add one dialog-local export control and derive its source from the same visible-record selection used by `renderHistory()`. Extract the existing Blob/anchor download mechanics into a shared helper while preserving the current-meeting Qwen freshness guard.

**Tech Stack:** HTML, inline CSS, browser-native JavaScript, Node.js built-in test runner, headless Chrome CDP tests.

**Spec:** `docs/superpowers/specs/2026-11-10-history-markdown-export-design.md`

## Global Constraints

- Keep all history on the browser under `meeting-demo.history.v1`; do not add a backend endpoint, cloud call, key handling, or schema change.
- Export the actual visible history detail, including its saved transcript; never overwrite the active draft or persist as a side effect.
- Preserve the current export button's stale-Qwen safety guard, existing history filter behavior, named controls, and quiet-editorial styling.

## Review Focus

- A filtered temporary selection must export the displayed match, not a hidden remembered selection.
- No-match or empty history must disable export rather than download stale/default content.
- History export must leave localStorage and the active draft byte-for-byte unchanged and make no network request.
- Both current and history exports must retain safe UTF-8 Markdown filenames/content after download-helper extraction.
- Download refusal must continue to present an actionable feedback message.

---

### Task 1: Export the Displayed Local History Record

**Files:**
- Modify: `tests/meeting-demo.browser.test.mjs`
- Modify: `index.html: history-detail markup, inline history styles, export/download helpers, history renderer, and event binding`

**Interfaces:**
- Consumes: `visibleHistoryRecords()`, `selectedHistoryRecord(records)`, `toMarkdown({ topic, transcript, minutes })`, `safeFileName()`, and current Blob/anchor export semantics.
- Produces: `#history-export-button` and `exportHistoryMarkdown()`; the control is disabled without a visible record and downloads only the resolved displayed record.

- [x] **Step 1: Write the failing browser regression**

Add `test('exports the displayed local history without changing the draft or storage', ...)`. Seed at least two valid local records, save the current draft/storage bytes, filter so a non-remembered record becomes the shown detail, capture Blob/filename, then assert saved-record-only Markdown, UTF-8 filename, zero post-setup fetch calls, and unchanged draft/storage. Add `test('disables history export without a visible record and explains blocked downloads', ...)` to assert the no-match disabled state and the existing actionable warning when `URL.createObjectURL` rejects.

- [x] **Step 2: Verify RED**

Run: `node --test --test-name-pattern="exports the displayed local history" tests/meeting-demo.browser.test.mjs`

Expected: FAIL because `#history-export-button` does not exist.

- [x] **Step 3: Implement shared local Markdown downloading and history export**

Add the labelled history-detail control, modal-local polite status output, and matching quiet-editorial spacing. Extract Blob/anchor creation into `downloadMarkdown({ topic, transcript, minutes, successMessage, onSuccess, onError })`; let current export retain its stale-Qwen guard and invoke the helper. Let `exportHistoryMarkdown()` resolve `selectedHistoryRecord(visibleHistoryRecords())`, download the saved fields, mirror result feedback inside the open dialog, and never persist or fetch. In `renderHistory()`, synchronize the disabled state to the resolved visible record.

- [x] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern="exports the displayed local history" tests/meeting-demo.browser.test.mjs`

Expected: PASS.

- [x] **Step 5: Verify complete behavior**

Run: `npm test`

Expected: all tests pass.
