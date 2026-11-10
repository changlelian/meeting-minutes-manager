# Draft Recovery Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the local-draft recovery accessibility and post-dismissal persistence contracts with real-browser regressions.

**Architecture:** Extend the existing CDP browser tests only. The failed-delete test will inspect the live status as a child of the native recovery dialog, while the missing-draft test will dispatch the app's real synchronous `pagehide` listener without creating new input, then read the localStorage key.

**Tech Stack:** Static HTML/vanilla JavaScript; Node.js built-in test runner; Chrome DevTools Protocol browser tests.

**Spec:** `docs/superpowers/specs/2026-11-10-draft-recovery-test-coverage-design.md`

## Global Constraints

- Do not change `index.html`, local-storage schemas, API boundaries, or application behavior.
- Exercise runtime DOM behavior; do not assert source-code strings.
- Do not dispatch an input event while proving missing-key persistence, because it would legitimately create a new draft.
- The workspace is not a Git repository; use direct tests and a per-plan ledger instead of commits or diff ranges.

## Review Focus

- A deletion exception leaves the warning inside the still-open recovery dialog (Task 1 new assertion).
- The warning remains assistive-technology-addressable through `status`, `polite`, and `atomic` attributes (Task 1 new assertion).
- A successful retry clears the warning only after the first assertion is sampled (existing retry assertion remains in Task 1).
- A missing snapshot remains absent after synchronous `pagehide`, rather than only immediately after a click (Task 1 new assertion).
- The missing-key test must not create a fresh draft through a synthetic input event (Task 1 evaluates only `pagehide` and `getItem`).

---

### Task 1: Browser Contracts for Recovery Status and Missing Drafts

**Files:**
- Modify: `tests/meeting-demo.browser.test.mjs:516-575` — enrich the two existing local-draft browser cases with runtime accessibility and persistence assertions.

**Interfaces:**
- Consumes: `#draft-restore-dialog`, `#draft-restore-status`, the installed `pagehide` persistence listener, and `meeting-demo.draft.v1`.
- Produces: stronger regression coverage only; no production interface changes.

- [x] **Step 1: Add the browser assertions**

  In the existing failed-delete result object, select `#draft-restore-status` from `#draft-restore-dialog` and return its warning text plus literal `role`, `aria-live`, and `aria-atomic` values. In the existing missing-draft test, dispatch `new Event('pagehide')` after dismissal and return the draft storage value. Assert the status is dialog-contained with `status`/`polite`/`true`, and that the later storage value is `null`.

- [x] **Step 2: Prove the new accessibility assertion is discriminating**

  Run the focused cases once with the real implementation, then make a temporary, immediately reverted one-attribute mutation that removes the status role from the recovery status element. Run the failed-delete case and verify that the new assertion fails for the expected missing role; restore the exact source before any final verification.

- [x] **Step 3: Run focused browser tests**

  Run: `node --test --test-name-pattern="discard recovered|missing recovery" tests/meeting-demo.browser.test.mjs`

  Expected: PASS for both cases with the unmodified application.

- [x] **Step 4: Run the full suite**

  Run: `npm test`

  Expected: all server, browser, and helper tests pass with no failures.

- [x] **Step 5: Record verification**

  Record the coverage mutation, focused run, full-suite result, and any scope ruling in `.superpowers/sdd/2026-11-10-draft-recovery-test-coverage/progress.md`; no Git commit is possible in this workspace.

## Self-Review

- Spec coverage: Task 1 covers both deferred gaps and explicitly avoids false proof from newly created input.
- Step scan: each step has one unambiguous test, mutation, verification, or record outcome.
- Type consistency: all assertions use existing DOM IDs and localStorage key names; no production interface is introduced.
- Review focus: every listed edge is either newly asserted or preserved by the same focused browser cases.
- Proportion: one test file and no production code changes fit the narrowly deferred coverage scope.
