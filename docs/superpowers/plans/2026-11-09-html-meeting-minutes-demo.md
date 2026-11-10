# HTML Meeting Minutes Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline, browser-openable Chinese HTML demo of the 会记 meeting-minutes workflow.

**Architecture:** A single `index.html` holds semantic markup, visual tokens, and a small namespaced JavaScript controller. Pure formatting, minutes-building, and Markdown-building helpers are exposed as `window.MeetingDemo` so Node's built-in test runner can exercise the content logic without installing a DOM package.

**Tech Stack:** HTML5, CSS, vanilla browser JavaScript, Node 24 built-in `node:test` and `vm`.

**Spec:** `docs/superpowers/specs/2026-11-09-html-meeting-minutes-demo-design.md`

## Global Constraints

- Deliver one offline-openable `index.html`; no framework, package install, CDN, network request, or API key.
- Label all fake behavior as 演示模式; do not claim the page calls Paraformer or `qwen-plus`.
- Use the paper/forest technical-minimal visual system defined in `.superdesign/design-system.md`.
- Use native labelled controls, Chinese `lang`, keyboard focus styling, and concise `role="status"` feedback.
- Generate Markdown as a UTF-8 Blob sourced from the current transcript and minutes.

## Review Focus

- Repeated Start/Stop clicks: there must be one active timer and no duplicated transcript segments — Task 2 test via state transition functions.
- Edited or empty transcript: generation must not lose user text and must produce a useful empty-state message — Task 1 tests.
- Chinese text / Unicode export: the Blob text must retain Chinese headings and user-entered characters — Task 1 tests.
- Offline `file://` opening: all CSS, icons, and logic must be inline with no remote source — Task 2 source test.
- Narrow or keyboard-only use: controls remain visible, focusable, and readable without a mouse — Task 2 source and manual browser verification.

---

### Task 1: Deterministic demo content helpers

**Files:**
- Create: `tests/meeting-demo.test.mjs`
- Create: `index.html`

**Interfaces:**
- Produces: `window.MeetingDemo.formatElapsed(seconds) -> string`
- Produces: `window.MeetingDemo.createMinutes(transcript, topic) -> { overview, conclusions, actions, questions }`
- Produces: `window.MeetingDemo.toMarkdown({ topic, transcript, minutes }) -> string`

- [ ] **Step 1: Write failing Node tests for display time, edited text retention, empty text, and Unicode Markdown**

```js
assert.equal(api.formatElapsed(65), '00:01:05');
assert.match(api.createMinutes('用户新增示例工作区', '产品评审').overview, /用户新增示例工作区/);
assert.match(api.createMinutes('', '产品评审').overview, /暂无/);
assert.match(api.toMarkdown(payload), /会议纪要/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/meeting-demo.test.mjs`
Expected: FAIL because `index.html` and `window.MeetingDemo` do not exist.

- [ ] **Step 3: Implement the pure helpers inside a classic inline script in `index.html`**

Expose only the three documented functions on `window.MeetingDemo`; retain user-entered Chinese source text in overview and Markdown, and derive a concise deterministic action list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/meeting-demo.test.mjs`
Expected: PASS.

- [ ] **Step 5: Record the missing Git commit constraint**

The workspace is not a Git repository, so do not fabricate a commit; leave the files unstaged and report this constraint.

### Task 2: Accessible offline meeting-workspace interaction

**Files:**
- Modify: `index.html`
- Modify: `tests/meeting-demo.test.mjs`

**Interfaces:**
- Consumes: `window.MeetingDemo` content helpers from Task 1.
- Produces: `window.MeetingDemo.startDemo()`, `stopDemo()`, `generateMinutes()`, and `exportMarkdown()` for UI event handlers.

- [ ] **Step 1: Extend the failing test with static acceptance checks for offline, semantic UI and required data hooks**

```js
assert.doesNotMatch(html, /https?:\/\//);
assert.match(html, /<textarea[^>]*id="transcript"/);
assert.match(html, /data-testid="record-button"/);
assert.match(html, /role="status"/);
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test tests/meeting-demo.test.mjs`
Expected: FAIL because the workspace markup and controls are not yet present.

- [ ] **Step 3: Implement the visual workspace, responsive styling, state controller, and export behavior in `index.html`**

Create the header, control strip, editable transcript pane, minutes pane, status region, and export button. Use one interval guarded by a `recording` flag, clear it when stopped, append local demo segments every 1.2 seconds, mark minutes stale after input, and download a UTF-8 Blob through `URL.createObjectURL` with a safe fallback status.

- [ ] **Step 4: Run the full test suite**

Run: `node --test tests/meeting-demo.test.mjs`
Expected: PASS.

- [ ] **Step 5: Manually verify desktop and narrow viewport behavior in a local browser**

Run: `python -m http.server 4173 --bind 127.0.0.1` and open `http://127.0.0.1:4173/`.
Expected: Start/Stop changes visible status and timer; generated minutes reflect edited transcript; export gives an `.md` download; layout stacks without horizontal scrolling at 900 px.

- [ ] **Step 6: Record the missing Git commit constraint**

The workspace is not a Git repository, so do not fabricate a commit; leave the files unstaged and report this constraint.
