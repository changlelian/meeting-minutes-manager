# Cross-Tab Local History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent sequential same-origin tabs from overwriting each other's locally stored meeting history while keeping the active draft and privacy model intact.

**Architecture:** Split storage reading from initial fallback seeding. Keep only records whose write failed in a transient pending list; before an archive, merge that list with the newest persisted snapshot and the current record using existing normalization. Handle `storage` events by rereading storage and merging pending records into view state.

**Tech Stack:** HTML, inline browser-native JavaScript, `localStorage` and `storage` events, Node.js built-in test runner, headless Chrome CDP tests.

**Spec:** `docs/superpowers/specs/2026-11-10-cross-tab-history-sync-design.md`

## Global Constraints

- Keep history exclusively in `meeting-demo.history.v1`; do not add a server endpoint, cloud request, credential, account, or schema migration.
- Preserve active topic, transcript, minutes, search query, and current-history viewing behavior when remote storage changes arrive.
- Retain the existing 20-record cap, normalization/deduplication semantics, malformed-storage fallback, and in-memory write-failure fallback.
- Protect sequential same-origin writes only; do not claim atomic resolution of simultaneous read-merge-write races.

## Review Focus

- An externally cleared or capped-out record must not be revived merely because this tab holds an old persisted snapshot.
- A record saved while storage is unavailable must still be included if persistence later recovers.
- `storage` changes must not reset the active draft, search query, or a still-valid selected history record.
- Existing malformed-storage startup fallback remains covered by its current browser regression while this task avoids changing that path.
- No history-sync path may call network APIs or expose provider/key state.

---

### Task 1: Reconcile Sequential Local History Updates

**Files:**
- Modify: `tests/meeting-demo.browser.test.mjs`
- Modify: `index.html: local history reader, state, archive persistence, and storage event handling`

**Interfaces:**
- Consumes: `normalizeHistory(records)`, `upsertHistory(records, record)`, `HISTORY_STORAGE_KEY`, `state.history`, and existing storage fallback behavior.
- Produces: a read-only persisted-history snapshot helper, transient pending history records, `reconcileHistoryFromStorage()`, and an event handler that refreshes history presentation without modifying the active draft.

- [x] **Step 1: Write failing browser regressions**

Add these independent browser regressions, each with its own localStorage seed and reload marker:

- `merges a newer local history snapshot before archiving the current meeting`: load an empty history, simulate an external post-startup record by writing valid storage directly without firing an event, generate a current local minutes record, then assert both records persist and the active draft remains unchanged.
- `refreshes local history after a same-origin storage event without changing the draft`: keep a search query and active draft, write a valid external record, dispatch a same-origin `StorageEvent`, then assert the list/count/detail update, zero event-triggered fetches, and unchanged query/draft.
- `respects an externally cleared local history`: dispatch a clear-style storage event after removing the history key, then assert old persisted records do not reappear.
- `keeps a pending in-memory record when storage recovers`: force the first history write to fail, restore storage access, introduce a valid external record, archive a second meeting, and assert all three records persist.
- `keeps local history when a remote payload is not an array`: dispatch a storage event after a valid-but-wrong-shaped JSON value is written and assert the current history remains visible.

- [x] **Step 2: Verify RED**

Run: `node --test --test-name-pattern="(merges a newer local history snapshot|refreshes local history after a same-origin storage event)" tests/meeting-demo.browser.test.mjs`

Expected: FAIL because the current page overwrites the unseen external record and has no storage-event reconciliation handler.

- [x] **Step 3: Implement bounded reconciliation**

Add a safe persisted-history reader that returns `null` on storage read/parse failures rather than replacing state. Track only records that failed to persist in transient `state.pendingHistory`; before archival, combine the current stored snapshot, pending records, and current record through existing normalization/upsert logic. After a successful write clear pending records. Add a `storage` listener for this key (and clear events) that rereads, merges pending records, and rerenders history without assigning draft fields.

- [x] **Step 4: Verify GREEN**

Run: `node --test --test-name-pattern="(merges a newer local history snapshot|refreshes local history after a same-origin storage event)" tests/meeting-demo.browser.test.mjs`

Expected: both tests PASS.

- [x] **Step 5: Verify complete behavior**

Run: `npm test`

Expected: all tests pass.
