# Runtime Connection Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Run the meeting demo on a loopback server and let users configure Host, API Key, and Qwen model without browser persistence.

**Architecture:** Add a dependency-free Node loopback server that owns an in-memory secret. Extend the native settings dialog so the page validates Host input then sends it to same-origin /api/config; the browser retains only non-secret status data.

**Tech Stack:** HTML5, CSS, vanilla JavaScript, Node.js HTTP server, Node node:test, Chrome CDP.

**Spec:** docs/superpowers/specs/2026-11-09-runtime-connection-config-design.md

## Global Constraints

- Bind only 127.0.0.1; never expose the configuration endpoint on the LAN.
- Require the current 127.0.0.1 Host and Origin for configuration POST requests, and return anti-framing response headers.
- Do not serialize or return an API Key after receipt.
- Allow only HTTP(S) Host URLs without embedded credentials.
- Do not issue an ASR/LLM request in this Demo.
- Preserve all recording, minutes, export, and history behavior.

## Review Focus

- Invalid Host, malformed JSON, oversized request body, and unsupported routes must fail without leaking configuration.
- GET /api/status must never contain the submitted key.
- Browser storage, history entries, Markdown export, and feedback must not contain a dummy submitted key.
- A direct file opening should explain that local-server configuration is unavailable rather than failing silently.
- Existing browser tests must retain a clean fetch implementation after configuration tests.

### Task 1: Loopback configuration server

**Files:**
- Create: server.mjs
- Create: tests/local-server.test.mjs

**Interfaces:**
- Produces: createMeetingServer({ indexPath? }) -> http.Server
- Produces: normalizeConnectionHost(value) -> string | null
- Produces: GET /api/status and POST /api/config

- [ ] Write failing server tests for valid configuration status, invalid host rejection, and no key in status.
- [ ] Run node --test tests/local-server.test.mjs and observe failure because server.mjs does not exist.
- [ ] Implement a bounded JSON loopback server that retains the key only in closure memory and serves index.html from /.
- [ ] Run node --test tests/local-server.test.mjs and observe passing tests.

### Task 2: Session-safe connection UI

**Files:**
- Modify: index.html
- Modify: tests/meeting-demo.browser.test.mjs

**Interfaces:**
- Produces: #connection-host, #connection-api-key, #connection-model, and #save-connection-button.
- Consumes: same-origin GET /api/status and POST /api/config.

- [ ] Write failing browser tests for a password key input, successful local config save, cleared key field, no key in localStorage, and invalid Host without fetch.
- [ ] Run node --test --test-name-pattern "connection config" tests/meeting-demo.browser.test.mjs and observe failure.
- [ ] Implement compact dialog fields, host validation, local-server status, and no browser key persistence.
- [ ] Run focused and full tests.

### Task 3: Local execution handoff

**Files:**
- Modify: none

- [ ] Launch node server.mjs --port 4173.
- [ ] Verify http://127.0.0.1:4173/ exposes the connection form.
- [ ] Report the local URL and let the user enter their own Host and API Key.
