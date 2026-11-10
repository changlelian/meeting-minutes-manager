# Unsaved Draft Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an accidental “新建会议” click from discarding an active, unarchived meeting without an explicit confirmation.

**Architecture:** Keep the existing one-page browser state model. Add a local native confirmation dialog and a separate `draftDirty` flag, while retaining `draftRevision` solely for rejecting stale Qwen responses. Route the New Meeting button through a guard that preserves existing state on cancel and invokes the established reset path only after explicit discard.

**Tech Stack:** Static HTML/CSS/vanilla JavaScript; Node.js built-in test runner; Chrome DevTools Protocol browser tests.

**Spec:** `docs/superpowers/specs/2026-11-10-unsaved-draft-guard-design.md`

## Global Constraints

- Preserve local-only history, user-supplied API Key handling, current API routes, and cross-tab history reconciliation.
- Add no dependencies, backend routes, account state, or persistent unarchived draft storage.
- Do not reuse `draftRevision` for dirty-state logic.
- Preserve the active draft and async generation when the user cancels or closes the dialog.
- The workspace is not a Git repository; no commit step or Git diff range is available.

## Review Focus

- Blank current meeting: clicking New Meeting must reset immediately without showing a confirmation dialog (Task 1 regression).
- Edited topic or transcript: clicking New Meeting must show confirmation and preserve visible content on cancel (Task 1 regression).
- Active demo/live-start state: confirmation must not stop capture until discard is confirmed (Task 1 regression).
- Completed archive with no later edits: New Meeting must remain a one-click action (Task 1 regression).
- Delayed Qwen result: confirm-discard must still make the old result stale, while cancel leaves it eligible to finish (Task 1 regression).

---

### Task 1: Guarded New Meeting Dialog

**Files:**
- Modify: `index.html:238-239` — add the accessible discard confirmation dialog.
- Modify: `index.html:336-557` — track independent dirty state, guard New Meeting, and preserve existing reset/async behavior.
- Modify: `tests/meeting-demo.browser.test.mjs` — add browser regressions and update intentional discard flows to confirm.

**Interfaces:**
- Consumes: existing `newMeeting()`, `abandonLiveRecording()`, `generateMinutes()`, and `draftRevision` stale-result contract.
- Produces: `requestNewMeeting(): void`, `shouldConfirmNewMeeting(): boolean`, and user-visible `#discard-draft-dialog` behavior.

- [x] **Step 1: Write failing browser tests**

  Add independent tests which type a draft, click `[data-testid="new-meeting-button"]`, and assert `#discard-draft-dialog.open === true`; closing it preserves topic, transcript, and recording state. Add a confirmed discard test that asserts the fields clear, history remains, and focus returns appropriately. Extend the delayed-Qwen test to explicitly confirm discard before resolving the old request.

- [x] **Step 2: Run the focused tests to verify they fail**

  Run: `node --test --test-name-pattern="draft|new meeting|delayed Qwen" tests/meeting-demo.browser.test.mjs`

  Expected: FAIL because the confirmation dialog and guard do not yet exist; prior direct-reset flows may also fail until they explicitly confirm.

- [x] **Step 3: Implement the minimal local dialog and guard**

  Add `draftDirty` independently from `draftRevision`. Set it on user/transcription content changes, clear it after archiving or actual reset, and only show `#discard-draft-dialog` while content is unarchived or a capture/generation is active. Bind discard to `newMeeting()` and cancel/close to a no-op that refocuses the New Meeting button.

- [x] **Step 4: Run focused tests to verify they pass**

  Run: `node --test --test-name-pattern="draft|new meeting|delayed Qwen" tests/meeting-demo.browser.test.mjs`

  Expected: PASS for all selected tests.

- [x] **Step 5: Run the full suite**

  Run: `npm test`

  Expected: all server, browser, and helper tests pass with no failures.

- [x] **Step 6: Record verification**

  No Git commit is possible because this workspace has no `.git` directory. Record red/green outcomes and any deliberately deferred scope in the SDD ledger.

## Self-Review

- Spec coverage: Task 1 covers confirmation, safe cancel/Esc behavior, confirmed reset, clean/blank bypass, focus return, and delayed Qwen behavior.
- Step scan: each step has one observable test, implementation, or verification result.
- Type consistency: `draftDirty` is independent from numeric `draftRevision`; `requestNewMeeting()` owns UI gating and `newMeeting()` remains the destructive action.
- Review focus: each listed failure mode is assigned to Task 1 browser regression coverage.
- Proportion: one existing UI subsystem changes; no unrelated abstractions or dependencies are introduced.
