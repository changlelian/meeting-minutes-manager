# Local Draft Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the latest unarchived topic and transcript after a local reload or accidental tab/page loss, only when the user explicitly accepts restoration.

**Architecture:** Extend the existing static page with a versioned `localStorage` draft snapshot separate from history. A validated snapshot is written after meaningful text changes with a short debounce and `pagehide` flush; startup holds it in memory until an accessible native dialog restores or discards it. Existing Qwen stale-result and history synchronization contracts remain unchanged.

**Tech Stack:** Static HTML/CSS/vanilla JavaScript; `localStorage`; Node.js built-in test runner; Chrome DevTools Protocol browser tests.

**Spec:** `docs/superpowers/specs/2026-11-10-local-draft-recovery-design.md`

## Global Constraints

- Store only `meetingId`, `topic`, `transcript`, and `savedAt` under `meeting-demo.draft.v1`.
- Never persist API Key, Base URL, audio, microphone/WebSocket state, Qwen output, or a live request.
- Restore requires an explicit user choice and always starts with capture stopped and minutes needing regeneration.
- Retain one latest snapshot only; never synchronize a draft into another tab's visible workspace from a `storage` event.
- Clear only a snapshot that matches the meeting being archived or explicitly discarded; startup suppresses a matching-ID snapshot only when its topic and transcript already equal the archived record.
- Preserve existing local-only history, API boundaries, and cross-tab history reconciliation.
- The workspace is not a Git repository; verification uses direct tests and a ledger rather than commits or diff ranges.

## Review Focus

- Reload immediately after edits: `pagehide` must leave a valid snapshot that can be restored without a Qwen call (Task 1 browser regression).
- Restore safety: restored minutes must be stale/empty and capture must not resume (Task 1 browser regression).
- Explicit discard/new meeting: an old snapshot must not reappear after the user deliberately removes it (Task 1 browser regression).
- Archive/edit/reload: a newer post-archive text edit with the same meeting ID must remain recoverable; failed history persistence must still require discard confirmation (Task 1 browser regression).
- Invalid or foreign storage: malformed, oversized, and same-origin foreign draft storage must not wipe, overwrite, or delete the last valid visible recovery state (Task 1 browser regression).

---

### Task 1: Local Recovery Snapshot and Dialog

**Files:**
- Modify: `index.html:238-245` — add an accessible local-draft restore dialog.
- Modify: `index.html:247-567` — validate, schedule, flush, restore, and clear recovery snapshots without changing API/recording contracts.
- Modify: `tests/meeting-demo.browser.test.mjs` — add realistic reload, discard, archive, malformed-data, and foreign-event regressions.

**Interfaces:**
- Consumes: current `currentMeetingId`, topic/transcript inputs, `archiveCurrentMeeting()`, `newMeeting()`, `pagehide`, and existing history `localStorage` key.
- Produces: `readPersistedDraft()`, `scheduleDraftPersistence()`, `flushDraftPersistence()`, `restorePendingDraft()`, and user-visible `#draft-restore-dialog` behavior.

- [x] **Step 1: Write failing browser tests**

  Add independently seeded browser tests that save an unarchived topic/transcript, reload, and require explicit restoration. Assert the snapshot has only the four allowed fields, Qwen output is not restored, discard removes the prompt on the next reload, a successful archive clears the snapshot, post-archive edits with the same ID remain recoverable, Escape retains the explicit choice, malformed/oversized storage preserves the last valid state, failed history persistence still guards discard, and a draft `storage` event does not overwrite the active draft.

- [x] **Step 2: Run focused tests to verify they fail**

  Run: `node --test --test-name-pattern="local draft|draft recovery|completed archive|archived meeting|Escape|exceeds|failed archive" tests/meeting-demo.browser.test.mjs`

  Expected: FAIL because no draft key, recovery dialog, persistence, or event isolation exists.

- [x] **Step 3: Implement the minimal snapshot lifecycle**

  Add strict snapshot validation and matching-ID deletion. Schedule writes after meaningful text changes, force a best-effort `pagehide` flush, suppress a snapshot already archived in history, show the restore/discard dialog, and restore only topic/transcript/meeting ID with empty stale minutes. Keep draft storage events ignored and clear matching snapshots after successful history persistence or explicit discard.

- [x] **Step 4: Run focused tests to verify they pass**

  Run: `node --test --test-name-pattern="local draft|draft recovery|completed archive|archived meeting|Escape|exceeds|failed archive" tests/meeting-demo.browser.test.mjs`

  Expected: PASS for all selected tests.

- [x] **Step 5: Run the full suite**

  Run: `npm test`

  Expected: all server, browser, and helper tests pass with no failures.

- [x] **Step 6: Record verification**

  No Git commit is possible because this workspace has no `.git` directory. Record red/green results and every scope ruling in the plan ledger.

## Self-Review

- Spec coverage: Task 1 covers writing, explicit restoration, discard, archive cleanup, validation, event isolation, and privacy boundaries.
- Step scan: each step is one observable test, implementation, or verification result.
- Type consistency: snapshot functions operate on one object shape `{ meetingId, topic, transcript, savedAt }`; they do not consume or produce Qwen/API credential state.
- Review focus: every listed data-loss or overwrite condition has a Task 1 browser regression.
- Proportion: the implementation extends the existing one-page persistence model without dependencies, backend changes, or a multi-draft subsystem.
