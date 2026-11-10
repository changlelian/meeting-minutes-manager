# History Meeting List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, local-only historical meeting list that can show each record's transcript and minutes without modifying the active draft.

**Architecture:** Keep the single-file application and add pure helpers for normalizing, upserting, and ordering history records. The DOM controller persists only validated records to versioned `localStorage`, while a native dialog supplies a keyboard-accessible master/detail history viewer.

**Tech Stack:** HTML5, CSS, vanilla JavaScript, browser `localStorage`, Node 24 `node:test`, Chrome CDP browser tests.

**Spec:** `docs/superpowers/specs/2026-11-09-history-meeting-list-design.md`

## Global Constraints

- Keep `index.html` offline-openable with no framework, CDN, network request, or API key.
- Persist only local meeting data under `meeting-demo.history.v1`; do not upload content.
- Preserve raw transcript newlines in saved records; render all history content through `textContent`.
- Limit history to 20 newest records; update a current meeting rather than duplicating it.
- History inspection must not overwrite the live draft or run during simulated recording.

## Review Focus

- Malformed/quota-blocked local storage must leave a usable in-memory list and a clear status — Task 1 unit test and Task 2 browser check.
- Repeated Generate for one current meeting must upsert rather than duplicate — Task 1 unit test and Task 2 browser test.
- New Meeting must retain history but make the following save a new record — Task 2 browser test.
- Raw multiline Chinese transcripts must remain multiline in historical detail after refresh — Task 2 browser test.
- Selecting a history record must never change an unsaved current draft — Task 2 browser test.

---

### Task 1: Local history model

**Files:**
- Modify: `index.html`
- Modify: `tests/meeting-demo.test.mjs`

**Interfaces:**
- Produces: `window.MeetingDemo.upsertHistory(records, record, limit = 20) -> HistoryRecord[]`
- Produces: `window.MeetingDemo.normalizeHistory(records) -> HistoryRecord[]`

- [ ] **Step 1: Write failing unit tests for upsert, descending order, 20-record retention, raw multiline transcript, and invalid records**

```js
const saved = api.upsertHistory([], record);
assert.equal(saved[0].transcript, '第一行\n第二行');
assert.equal(api.upsertHistory(saved, { ...record, savedAt: '2026-11-09T10:00:00Z' }).length, 1);
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `node --test tests/meeting-demo.test.mjs`
Expected: FAIL because the history helpers do not yet exist.

- [ ] **Step 3: Implement validated local history helpers in `index.html`**

Use safe string/object checks, retain raw transcript text, replace matching IDs, sort newest-first, and cap at 20 records.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `node --test tests/meeting-demo.test.mjs`
Expected: PASS.

### Task 2: History archive and read-only viewer

**Files:**
- Modify: `index.html`
- Modify: `tests/meeting-demo.browser.test.mjs`

**Interfaces:**
- Consumes: `upsertHistory()` and `normalizeHistory()` from Task 1.
- Produces: visible `#history-button`, `#history-dialog`, `#history-list`, and read-only `#history-transcript` UI hooks.

- [ ] **Step 1: Write a failing browser test for auto-save, reload persistence, detailed record viewing, and draft isolation**

```js
assert.match(await detail.innerText(), /第一行/);
assert.equal(await currentTranscript.inputValue(), '未保存的当前草稿');
```

- [ ] **Step 2: Run the targeted browser test to verify it fails**

Run: `node --test --test-name-pattern "history" tests/meeting-demo.browser.test.mjs`
Expected: FAIL because no history controls or persisted record exist.

- [ ] **Step 3: Implement the history button, native master/detail dialog, generation archive, storage fallback, and new-meeting behavior**

Use native list buttons with `aria-current`, native `time` elements, `readonly` transcript display, and status feedback. Disable history while recording; do not mutate live editor state when a history list item is selected.

- [ ] **Step 4: Run the complete suite**

Run: `node --test tests\\*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Record the missing Git commit constraint**

The workspace is not a Git repository, so do not fabricate a commit; leave files uncommitted and report the constraint.
