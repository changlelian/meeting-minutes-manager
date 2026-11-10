# Electron Desktop Client Implementation Plan

> **For agentic workers:** Required skills: `superpowers:test-driven-development`, `superpowers:verification-before-completion`, and a fresh final code review. This workspace is not a Git repository at plan start, so use the plan ledger and direct test output in place of commit ranges until the final GitHub delivery task.

**Goal:** Deliver the existing meeting-minutes demo as a secure Electron Windows desktop client, with persistent local history/drafts, memory-only BaiLian credentials, test coverage, packaging commands, and a GitHub push.

**Architecture:** Electron main starts the existing loopback server on a stable, dedicated `127.0.0.1:4174` origin, then loads it in a hardened BrowserWindow using a named persistent session. A per-launch random token is injected into same-origin HTTP/WebSocket requests by that session and verified by the loopback server. The renderer remains the existing static page with no Electron bridge. Server lifecycle code is kept independently testable; desktop runtime code receives Electron dependencies so Node tests can use fakes.

**Tech Stack:** Node.js ESM; Electron 45; electron-builder 26; Node built-in test runner; existing Chrome browser tests; Windows NSIS packaging.

**Spec:** `docs/superpowers/specs/2026-11-10-electron-desktop-client-design.md`

## Global Constraints

- Keep `node server.mjs` as an opt-in browser demo on its current default port and without a required desktop token.
- Desktop production origin is exactly `http://127.0.0.1:4174`; never fall back to another port or attach to an existing listener.
- The renderer receives no Node, Electron, filesystem, shell, or secret-bearing preload bridge.
- API Key remains memory-only in the local server and must not appear in storage, DOM, URL, IPC, network responses, or error text.
- A desktop token is random per launch, never exposed to the renderer, and must gate desktop page/API/ASR access.
- Main-window media permissions allow only audio from the exact desktop origin; all other permissions, origins, child frames and windows are denied.
- Existing local history and draft schemas must remain unchanged. Browser-demo data does not need automatic migration into Electron.
- Do not force-push, rewrite remote history, or publish a release. Push only the final tested source to `https://github.com/changlelian/meeting-minutes-manager.git`.

## Review Focus

- A desktop token changes authorization only when enabled and never leaks through status, rejection text, or upstream headers.
- A wrong token cannot reach `/`, `/api/status`, `/api/config`, `/api/minutes`, or `/api/asr-stream`; the existing browser-demo test behavior remains intact without one.
- Startup never opens a BrowserWindow before listening succeeds; a port collision leaves no window and does not silently use another port.
- The Electron request-header hook covers both HTTP navigation/fetch and WebSocket handshakes without exposing the token to page JavaScript.
- Permission checks require the actual main `webContents`, exact origin, top frame and audio-only media.
- Quit releases the HTTP listener and active ASR sockets; restarting preserves the stable source that owns Electron local history/drafts.
- Package output includes only runtime files and production `ws` dependency, launches `desktop/main.mjs`, and documents user-owned Base URL/API Key configuration.

---

### Task 1: Token-Gated Desktop Loopback Server

**Files:**
- Modify: `server.mjs`
- Modify: `tests/local-server.test.mjs`

**Interfaces:**
- Produces: `DESKTOP_CAPABILITY_HEADER`, `startMeetingServer(options)`, and a server close helper suitable for Electron lifecycle management.
- Consumes: `createMeetingServer({ desktopToken })`, the current exact loopback-host / Origin validation, and current HTTP/WebSocket routes.

- [ ] **Step 1: Write failing server tests**

  Add real loopback tests showing that a server with `desktopToken: 'desktop-test-token'` rejects missing/wrong-token page, status, configuration and ASR handshakes; accepts a matching token with the existing exact Origin validation; and never includes the token in response bodies. Add a lifecycle test that starts a supplied port/host through the exported helper, returns its exact loopback origin, and releases it after stop. Preserve a control assertion that token-less browser-demo server behavior remains unchanged.

- [ ] **Step 2: Run focused tests to verify RED**

  Run: `node --test --test-name-pattern="desktop token|managed loopback" tests/local-server.test.mjs`

  Expected: FAIL because no desktop token policy or managed lifecycle API exists.

- [ ] **Step 3: Implement minimal server behavior**

  Add a constant request-header name, strict matching token validation, token-aware page/status/API/ASR routing, and explicit async start/stop helpers. The default token-less factory behavior must remain unchanged. Ensure stop terminates active local ASR clients before closing the HTTP listener.

- [ ] **Step 4: Run focused tests to verify GREEN**

  Run: `node --test --test-name-pattern="desktop token|managed loopback" tests/local-server.test.mjs`

  Expected: all selected tests pass.

- [ ] **Step 5: Run full suite**

  Run: `npm test`

  Expected: all existing and new tests pass.

### Task 2: Hardened Electron Runtime and Main Process

**Files:**
- Create: `desktop/runtime.mjs`
- Create: `desktop/main.mjs`
- Create: `tests/desktop.test.mjs`

**Interfaces:**
- Consumes: Task 1 `startMeetingServer` / close helper and `DESKTOP_CAPABILITY_HEADER`.
- Produces: `createDesktopRuntime(dependencies)` with `start()`, `stop()` and `focusMainWindow()`; main-process startup uses its stable origin.

- [ ] **Step 1: Write failing desktop-runtime tests**

  With an injected fake `BrowserWindow` and Electron session plus a real loopback server, assert: server listens before `loadURL`; loaded URL is the returned stable origin; required hardened `webPreferences` are passed; the request hook injects the token for both `http://` and `ws://` forms; untrusted navigation/open-window operations are denied; only current top-level window + exact origin + audio permission can be granted; stop releases the port. Add a collision test proving a failed listen creates no window.

- [ ] **Step 2: Run focused tests to verify RED**

  Run: `node --test tests/desktop.test.mjs`

  Expected: FAIL because the runtime module does not exist.

- [ ] **Step 3: Implement testable runtime and Electron entry point**

  Implement the runtime with explicit dependency injection and a 256-bit URL-safe per-launch token. Create the `BrowserWindow` only after a successful loopback listen; configure persistent session request headers and permission handlers before `loadURL`; deny unsafe renderer behavior. Main process acquires a single-instance lock, reports startup errors, focuses the existing window, and closes runtime resources during quit.

- [ ] **Step 4: Run focused tests to verify GREEN**

  Run: `node --test tests/desktop.test.mjs`

  Expected: all desktop-runtime tests pass.

- [ ] **Step 5: Run full suite**

  Run: `npm test`

  Expected: all server, browser and desktop-runtime tests pass.

### Task 3: Desktop Packaging and Operating Guide

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 2 `desktop/main.mjs` and Node module dependency `ws`.
- Produces: `npm run desktop`, `npm run desktop:pack`, `npm run desktop:dist`, Electron/electron-builder lockfile entries, a package entry point, and Windows packaging metadata.

- [ ] **Step 1: Add package/guide acceptance checks**

  Add a Node test that reads `package.json` as data and asserts the desktop entry point, run scripts and Windows builder metadata resolve to the implemented files. It must assert behaviorally meaningful integration metadata rather than source-text implementation details.

- [ ] **Step 2: Run targeted package check to verify RED**

  Run: `node --test tests/desktop.test.mjs`

  Expected: FAIL because there is no Electron entry point or package script metadata.

- [ ] **Step 3: Add dependencies, package settings and usage guide**

  Add exact Electron/electron-builder development dependencies, build configuration with `asar: true`, named Windows NSIS output, package entry point and scripts. Document installation, start, packaging, microphone permission, user-configured Base URL/API Key, privacy behavior, stable-port conflict handling, and browser-history migration boundary. Add `.gitignore` for dependencies, packaging output and local process ledgers.

- [ ] **Step 4: Run metadata check and full suite**

  Run: `node --test tests/desktop.test.mjs && npm test`

  Expected: desktop metadata tests and entire project suite pass.

- [ ] **Step 5: Produce a Windows package smoke artifact**

  Run: `npm run desktop:pack`

  Expected: electron-builder creates a `dist/win-unpacked` directory with a runnable application executable and no packaging errors.

### Task 4: GitHub Source Delivery

**Files:**
- Create/modify: `.git` metadata only; no source changes required unless a safe delivery issue is discovered.

**Interfaces:**
- Consumes: Tasks 1–3 verified project tree and user-supplied GitHub URL.
- Produces: a non-force `main` push to `https://github.com/changlelian/meeting-minutes-manager.git`.

- [ ] **Step 1: Inspect remote safely**

  Run: `git ls-remote --symref https://github.com/changlelian/meeting-minutes-manager.git HEAD`

  Expected: remote state is identified without modifying it. If it contains unrelated history, stop before any merge or force action and report the conflict.

- [ ] **Step 2: Initialize and commit the verified tree**

  Initialize a local `main` repository only if absent; add the exact remote; set a local-only commit identity if needed; review `git status`; commit the tested source with a descriptive message. Do not include `node_modules`, `dist`, local ledgers or secrets.

- [ ] **Step 3: Push without rewriting history**

  Run: `git push -u origin main`

  Expected: remote reports a new/up-to-date `main` branch. Record the resulting commit SHA and remote URL in the ledger.

## Self-Review

- Security: token gate, isolation, permission checks and fixed-port behavior are independently testable; package configuration does not add a renderer bridge.
- Compatibility: direct browser demo retains its no-token behavior, while Electron uses a dedicated stable origin and profile.
- Reliability: startup is ordered and failure-visible; app shutdown actively releases WS/HTTP resources.
- Delivery: tests cover server, desktop policy, page interactions, package metadata and packaging; GitHub delivery is non-force and explicitly remote-checked.
