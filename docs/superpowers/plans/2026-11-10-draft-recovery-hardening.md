# Draft Recovery Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local draft deletion outcomes truthful and make recovery timestamps canonical before offering a restore choice.

**Architecture:** Keep the existing single-key local draft model, but promote cleanup from a boolean side effect to a four-result operation. The restore dialog receives an accessible in-dialog failure status, while reset protection uses the same outcome to avoid clearing a meeting whose only recovery copy could not be removed. Snapshot timestamps use exact `Date#toISOString()` round-trip validation.

**Tech Stack:** Static HTML/CSS/vanilla JavaScript; `localStorage`; Node.js built-in test runner; Chrome DevTools Protocol browser tests.

**Spec:** `docs/superpowers/specs/2026-11-10-draft-recovery-hardening-design.md`

## Global Constraints

- Keep the snapshot schema exactly `{ meetingId, topic, transcript, savedAt }` under `meeting-demo.draft.v1`.
- Never persist API Key, Base URL, audio, microphone/WebSocket state, Qwen output, or a live request.
- Do not delete a malformed, missing, or foreign meeting's draft as a side effect of cleanup.
- Failed deletion must not report success; an open modal must expose its failure to assistive technology.
- The workspace is not a Git repository; use direct tests and a per-plan ledger instead of commits or diff ranges.

## Review Focus

- A `removeItem` exception leaves the original bytes, pending recovery state, and an operable dialog intact (Task 1 browser regression).
- A draft removed after the modal opens produces a truthful absent result without reintroducing or deleting data (Task 1 browser regression).
- A same-origin replacement draft is never removed by an older recovery dialog (Task 1 browser regression).
- Confirmed New Meeting keeps visible source text when the current recovery copy cannot be cleared (Task 1 browser regression).
- Noncanonical parseable time values such as `"1"` and JavaScript-normalized calendar dates are ignored while a canonical UTC ISO value remains accepted (Task 1 browser regression).

---

### Task 1: Truthful Cleanup Outcomes and Canonical Snapshot Time

**Files:**
- Modify: `index.html:96-108,246,337-410,625-633` — add dialog status, canonical timestamp validation, cleanup results, and reset protection.
- Modify: `tests/meeting-demo.browser.test.mjs:477-640` — add browser regressions for deletion outcomes, reset protection, and timestamp validation.

**Interfaces:**
- Consumes: `readPersistedDraft()`, `pendingDraftRestore`, `newMeeting()`, local `Storage` APIs, and the existing restore dialog.
- Produces: `clearPersistedDraft(meetingId) -> 'removed' | 'missing' | 'foreign' | 'failed'`, canonical `normalizeDraftSnapshot()` time acceptance, and visible `#draft-restore-status` behavior.

- [x] **Step 1: Write failing browser tests**

  Add real-browser tests that inject a draft-key-only `removeItem` exception and assert that the modal remains open with an in-modal warning and original bytes, then succeeds on retry. Add separate missing and foreign-replacement cases that assert truthful non-success copy and preserved foreign bytes. Add a confirmed-New-Meeting failure case that retains the current topic/transcript. Seed `savedAt` with `"1"` and `2026-02-30T09:30:00.000Z` on separate reloads, asserting no restore prompt and unchanged raw storage.

- [x] **Step 2: Run focused tests to verify they fail**

  Run: `node --test --test-name-pattern="discard recovered|missing recovery|foreign recovery|cannot clear|noncanonical" tests/meeting-demo.browser.test.mjs`

  Expected: FAIL because cleanup has one false/success path, reset continues after a deletion exception, and parseable noncanonical timestamps are accepted.

- [x] **Step 3: Implement the minimal cleanup and validation behavior**

  Add the in-dialog live status and change `clearPersistedDraft` to return one of the four named outcomes. Keep the restore dialog pending on `failed`; distinguish absent and foreign results without altering another draft. Abort a confirmed reset only for a failed deletion of the current recoverable meeting. Accept `savedAt` only after a finite parse and exact `toISOString()` round trip.

- [x] **Step 4: Run focused tests to verify they pass**

  Run: `node --test --test-name-pattern="discard recovered|missing recovery|foreign recovery|cannot clear|noncanonical" tests/meeting-demo.browser.test.mjs`

  Expected: PASS for all selected tests.

- [x] **Step 5: Run the full suite**

  Run: `npm test`

  Expected: all server, browser, and helper tests pass with no failures.

- [x] **Step 6: Record verification**

  Record the RED/GREEN/full-suite results and every scope ruling in `.superpowers/sdd/2026-11-10-draft-recovery-hardening/progress.md`; no Git commit is possible in this workspace.

## Self-Review

- Spec coverage: Task 1 covers all four cleanup outcomes, the reset path, in-modal accessibility feedback, and canonical time validation.
- Step scan: each step is a distinct test, verification, implementation, or recordable result.
- Type consistency: the outcome string union is consumed by recovery-discard and new-meeting flows; the snapshot shape remains unchanged.
- Review focus: every listed reliability boundary is pinned to a browser regression in Task 1.
- Proportion: this remains a small additive hardening of the existing one-page local-storage lifecycle with no dependencies or backend changes.
