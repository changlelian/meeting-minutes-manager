import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let server;
let serverUrl;
let browser;
let profileDir;
let cdp;

function waitFor(predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for browser debugging endpoint.'));
      }
    }, 40);
  });
}

function serveDemo() {
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      if (request.url === '/api/status') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ configured: false, host: '', model: 'qwen-plus', asrEndpoint: '' }));
        return;
      }
      const fileName = request.url === '/' ? 'index.html' : request.url?.replace(/^\//, '');
      if (fileName !== 'index.html') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readFileSync(join(root, 'index.html')));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}/index.html`);
    });
  });
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome DevTools.')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }

  close() {
    this.socket?.close();
  }
}

async function openDemoInChrome() {
  profileDir = mkdtempSync(join(tmpdir(), 'meeting-demo-chrome-'));
  browser = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    serverUrl,
  ], { windowsHide: true, stdio: 'ignore' });

  const activePortPath = join(profileDir, 'DevToolsActivePort');
  await waitFor(() => existsSync(activePortPath));
  const [port] = readFileSync(activePortPath, 'utf8').trim().split(/\r?\n/);
  let target;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((item) => item.type === 'page' && item.url.includes('/index.html'));
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!target) throw new Error('Could not find the demo page in Chrome DevTools.');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="record-button"]'))`)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('The demo page loaded without its recording controls.');
}

async function waitForPageValue(expression, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for page expression: ${expression}`);
}

async function prepareCleanDraftPage() {
  await cdp.evaluate(`(() => {
    const restoreDialog = document.querySelector('#draft-restore-dialog');
    if (restoreDialog?.open) restoreDialog.close();
    localStorage.removeItem('meeting-demo.draft.v1');
    document.querySelector('[data-testid="new-meeting-button"]').click();
    document.querySelector('#discard-draft-button')?.click();
    localStorage.removeItem('meeting-demo.draft.v1');
  })()`);
  await waitForPageValue(`!document.querySelector('#draft-restore-dialog')?.open && !document.querySelector('#discard-draft-dialog')?.open`);
}

before(async () => {
  assert.equal(existsSync(chromePath), true, 'Chrome is required for the browser demo test.');
  serverUrl = await serveDemo();
  await openDemoInChrome();
});

after(async () => {
  cdp?.close();
  if (browser && !browser.killed) {
    browser.kill();
    await once(browser, 'exit');
  }
  await new Promise((resolve) => server?.close(resolve));
  if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test('labels bundled history as demo records', async () => {
  await cdp.evaluate(`document.querySelector('[data-testid="history-button"]').click()`);
  const label = await cdp.evaluate(`document.querySelector('[data-history-id="seed-product-review"]').textContent.trim()`);
  assert.match(label, /演示/);
  await cdp.evaluate(`document.querySelector('#close-history-dialog-button').click()`);
});

test('presents local-only history in an accessible, viewport-safe workspace', async () => {
  const layout = await cdp.evaluate(`(() => {
    const historyButton = document.querySelector('[data-testid="history-button"]');
    historyButton.click();
    const dialog = document.querySelector('#history-dialog');
    const result = {
      localNote: document.querySelector('#history-local-note')?.textContent.trim(),
      footer: document.querySelector('#feedback')?.textContent.trim(),
      recordHeight: parseFloat(getComputedStyle(document.querySelector('[data-testid="record-button"]')).height),
      historyHeight: parseFloat(getComputedStyle(historyButton).height),
      settingsHeight: parseFloat(getComputedStyle(document.querySelector('#settings-button')).height),
      dialogMaxHeight: getComputedStyle(dialog).maxHeight
    };
    document.querySelector('#close-history-dialog-button').click();
    return result;
  })()`);

  assert.match(layout.localNote ?? '', /仅保存在当前浏览器/);
  assert.match(layout.footer ?? '', /不会上传/);
  assert.ok(layout.recordHeight >= 40);
  assert.ok(layout.historyHeight >= 40);
  assert.ok(layout.settingsHeight >= 40);
  assert.notEqual(layout.dialogMaxHeight, 'none');
});

test('focuses history dialog search after opening from active meeting controls', async () => {
  const result = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    topic.focus();
    document.querySelector('[data-testid="history-button"]').click();
    const dialog = document.querySelector('#history-dialog');
    const outcome = { dialogOpen: dialog.open, focusedId: document.activeElement?.id };
    dialog.close();
    return outcome;
  })()`);
  assert.equal(result.dialogOpen, true);
  assert.equal(result.focusedId, 'history-filter');
});

test('closes populated history dialog search with Escape and preserves it on reopen', async () => {
  let reopened;
  try {
    const beforeEscape = await cdp.evaluate(`(() => {
      const topic = document.querySelector('#meeting-topic');
      const transcript = document.querySelector('#transcript');
      topic.focus();
      document.querySelector('[data-testid="history-button"]').click();
      const filter = document.querySelector('#history-filter');
      filter.focus();
      filter.value = '新用户';
      filter.dispatchEvent(new Event('input', { bubbles:true }));
      return {
        topic: topic.value,
        transcript: transcript.value,
        query: filter.value,
        selectedId: document.querySelector('[data-history-id]')?.dataset.historyId,
        selectedTopic: document.querySelector('#history-topic').textContent.trim()
      };
    })()`);
    assert.equal(beforeEscape.query, '新用户');
    assert.equal(beforeEscape.selectedId, 'seed-product-review');

    await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
    await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const closed = await cdp.evaluate(`({
      dialogOpen: document.querySelector('#history-dialog').open,
      focusedId: document.activeElement?.id,
      query: document.querySelector('#history-filter').value,
      topic: document.querySelector('#meeting-topic').value,
      transcript: document.querySelector('#transcript').value
    })`);
    assert.equal(closed.dialogOpen, false);
    assert.equal(closed.focusedId, 'history-button');
    assert.equal(closed.query, beforeEscape.query);
    assert.equal(closed.topic, beforeEscape.topic);
    assert.equal(closed.transcript, beforeEscape.transcript);

    reopened = await cdp.evaluate(`(() => {
      document.querySelector('[data-testid="history-button"]').click();
      return {
        dialogOpen: document.querySelector('#history-dialog').open,
        focusedId: document.activeElement?.id,
        query: document.querySelector('#history-filter').value,
        selectedId: document.querySelector('[data-history-id]')?.dataset.historyId,
        selectedTopic: document.querySelector('#history-topic').textContent.trim()
      };
    })()`);
    assert.equal(reopened.dialogOpen, true);
    assert.equal(reopened.focusedId, 'history-filter');
    assert.equal(reopened.query, beforeEscape.query);
    assert.equal(reopened.selectedId, beforeEscape.selectedId);
    assert.equal(reopened.selectedTopic, beforeEscape.selectedTopic);
  } finally {
    await cdp.evaluate(`(() => { const dialog = document.querySelector('#history-dialog'); if (dialog.open) dialog.close(); })()`);
  }
});

test('keeps a full local history list independently scrollable at desktop and narrow widths', async () => {
  await cdp.evaluate(`(() => {
    const minutes = { overview: '本机保存的会议纪要。', conclusions: [], actions: [], questions: [] };
    const records = Array.from({ length: 20 }, (_, index) => ({
      id: 'scroll-history-' + index,
      topic: '本地历史会议 ' + (index + 1),
      savedAt: new Date(2026, 0, index + 1, 9, 0).toISOString(),
      transcript: '本地逐字稿 ' + (index + 1),
      minutes
    }));
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify(records));
    location.reload();
  })()`);
  await waitForPageValue(`document.querySelectorAll('[data-history-id]').length === 20`);
  await cdp.evaluate(`document.querySelector('[data-testid="history-button"]').click()`);

  const getHistoryMetrics = `(() => {
    const list = document.querySelector('#history-list');
    const dialog = document.querySelector('#history-dialog');
    const close = document.querySelector('#close-history-dialog-button');
    const dialogBounds = dialog.getBoundingClientRect();
    const closeBounds = close.getBoundingClientRect();
    return {
      itemCount: document.querySelectorAll('[data-history-id]').length,
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      overflowY: getComputedStyle(list).overflowY,
      closeWithinDialog: closeBounds.top >= dialogBounds.top && closeBounds.bottom <= dialogBounds.bottom
    };
  })()`;

  try {
    const desktop = await cdp.evaluate(getHistoryMetrics);
    assert.equal(desktop.itemCount, 20);
    assert.match(desktop.overflowY, /auto|scroll/);
    assert.ok(desktop.scrollHeight > desktop.clientHeight);
    assert.equal(desktop.closeWithinDialog, true);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 640, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const narrow = await cdp.evaluate(getHistoryMetrics);
    assert.equal(narrow.itemCount, 20);
    assert.match(narrow.overflowY, /auto|scroll/);
    assert.ok(narrow.scrollHeight > narrow.clientHeight);
    assert.equal(narrow.closeWithinDialog, true);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
});

test('records demo transcript and freezes it after stop', async () => {
  const initial = await cdp.evaluate(`({
    hasRecordButton: Boolean(document.querySelector('[data-testid="record-button"]')),
    status: document.querySelector('[data-testid="record-status"]')?.textContent.trim(),
    transcript: document.querySelector('#transcript')?.value
  })`);
  assert.equal(initial.hasRecordButton, true);
  assert.match(initial.status, /准备就绪/);

  await cdp.evaluate(`document.querySelector('[data-testid="record-button"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  const recording = await cdp.evaluate(`({
    status: document.querySelector('[data-testid="record-status"]').textContent.trim(),
    elapsed: document.querySelector('[data-testid="elapsed"]').textContent.trim(),
    transcript: document.querySelector('#transcript').value
  })`);
  assert.match(recording.status, /录音中/);
  assert.notEqual(recording.elapsed, '00:00:00');
  assert.match(recording.transcript, /激活情况/);

  await cdp.evaluate(`document.querySelector('[data-testid="record-button"]').click()`);
  const stoppedElapsed = await cdp.evaluate(`document.querySelector('[data-testid="elapsed"]').textContent.trim()`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const stopped = await cdp.evaluate(`({
    status: document.querySelector('[data-testid="record-status"]').textContent.trim(),
    elapsed: document.querySelector('[data-testid="elapsed"]').textContent.trim()
  })`);
  assert.match(stopped.status, /已暂停/);
  assert.equal(stopped.elapsed, stoppedElapsed);
});

test('generates editable transcript into minutes and exports UTF-8 Markdown', async () => {
  await cdp.evaluate(`(() => {
    const transcript = document.querySelector('#transcript');
    transcript.value = '团队决定新增示例工作区，并于周三交付设计稿。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="generate-button"]').click();
  })()`);
  const overview = await cdp.evaluate(`document.querySelector('[data-testid="minutes-overview"]').textContent.trim()`);
  assert.match(overview, /团队决定新增示例工作区/);

  await cdp.evaluate(`(() => {
    window.__exportCapture = {};
    URL.createObjectURL = (blob) => { window.__exportCapture.blob = blob; return 'blob:meeting-demo'; };
    HTMLAnchorElement.prototype.click = function click() { window.__exportCapture.fileName = this.download; };
    document.querySelector('[data-testid="export-button"]').click();
  })()`);
  const exported = await cdp.evaluate(`(async () => ({
    fileName: window.__exportCapture.fileName,
    content: await window.__exportCapture.blob.text()
  }))()`);
  assert.match(exported.fileName, /会议纪要.*\.md$/);
  assert.match(exported.content, /团队决定新增示例工作区/);
  assert.match(exported.content, /## 行动项/);
});

test('keeps an unarchived draft and active demo recording when new meeting is canceled', async () => {
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    window.__draftGuardCancelReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftGuardCancelReloadMarker === undefined && Boolean(document.querySelector('[data-testid="new-meeting-button"]'))`);

  const opened = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '未归档会议';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '这是一段还未归档的草稿。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="record-button"]').click();
    const draft = transcript.value;
    document.querySelector('[data-testid="new-meeting-button"]').click();
    return {
      dialogOpen: Boolean(document.querySelector('#discard-draft-dialog')?.open),
      topic: topic.value,
      transcript: draft,
      status: document.querySelector('[data-testid="record-status"]').textContent.trim(),
      focusedId: document.activeElement?.id
    };
  })()`);
  assert.equal(opened.dialogOpen, true);
  assert.equal(opened.topic, '未归档会议');
  assert.match(opened.transcript, /还未归档的草稿/);
  assert.match(opened.status, /录音中/);
  assert.equal(opened.focusedId, 'continue-editing-button');

  await cdp.evaluate(`document.querySelector('#continue-editing-button')?.click()`);
  await waitForPageValue(`!document.querySelector('#discard-draft-dialog')?.open && document.activeElement?.id === 'reset-button'`);
  const canceled = await cdp.evaluate(`({
    dialogOpen: Boolean(document.querySelector('#discard-draft-dialog')?.open),
    topic: document.querySelector('#meeting-topic').value,
    transcript: document.querySelector('#transcript').value,
    status: document.querySelector('[data-testid="record-status"]').textContent.trim(),
    focusedId: document.activeElement?.id
  })`);
  assert.equal(canceled.dialogOpen, false);
  assert.equal(canceled.topic, opened.topic);
  assert.equal(canceled.transcript, opened.transcript);
  assert.match(canceled.status, /录音中/);
  assert.equal(canceled.focusedId, 'reset-button');
});

test('discards a draft only after confirmation and bypasses the dialog for a blank meeting', async () => {
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="new-meeting-button"]').click();
    document.querySelector('#discard-draft-button')?.click();
    localStorage.removeItem('meeting-demo.draft.v1');
    const minutes = { overview: '已归档记录。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'retained-history', topic: '保留历史', savedAt: '2026-11-10T09:00:00.000Z', transcript: '已归档逐字稿。', minutes }
    ]));
    window.__draftGuardDiscardReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftGuardDiscardReloadMarker === undefined && Number(document.querySelector('#history-count').textContent) === 1`);

  const opened = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '将被丢弃的会议';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '确认后才允许清空。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="new-meeting-button"]').click();
    return Boolean(document.querySelector('#discard-draft-dialog')?.open);
  })()`);
  assert.equal(opened, true);

  await cdp.evaluate(`document.querySelector('#discard-draft-button')?.click()`);
  await waitForPageValue(`!document.querySelector('#discard-draft-dialog')?.open && document.activeElement?.id === 'reset-button'`);
  const discarded = await cdp.evaluate(`({
    dialogOpen: Boolean(document.querySelector('#discard-draft-dialog')?.open),
    topic: document.querySelector('#meeting-topic').value,
    transcript: document.querySelector('#transcript').value,
    historyCount: Number(document.querySelector('#history-count').textContent),
    focusedId: document.activeElement?.id
  })`);
  assert.equal(discarded.dialogOpen, false);
  assert.equal(discarded.topic, '');
  assert.equal(discarded.transcript, '');
  assert.equal(discarded.historyCount, 1);
  assert.equal(discarded.focusedId, 'reset-button');

  const blankMeeting = await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="new-meeting-button"]').click();
    return Boolean(document.querySelector('#discard-draft-dialog')?.open);
  })()`);
  assert.equal(blankMeeting, false);
});

test('starts a new meeting directly after the current meeting was archived without later edits', async () => {
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    window.__draftGuardArchivedReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftGuardArchivedReloadMarker === undefined && Boolean(document.querySelector('[data-testid="generate-button"]'))`);

  const result = await cdp.evaluate(`(() => {
    const transcript = document.querySelector('#transcript');
    transcript.value = '这条逐字稿会先归档。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="generate-button"]').click();
    document.querySelector('[data-testid="new-meeting-button"]').click();
    return {
      dialogOpen: Boolean(document.querySelector('#discard-draft-dialog')?.open),
      transcript: transcript.value,
      historyCount: Number(document.querySelector('#history-count').textContent)
    };
  })()`);
  assert.equal(result.dialogOpen, false);
  assert.equal(result.transcript, '');
  assert.equal(result.historyCount, 1);
});

test('restores local draft after reload only when the user chooses recovery', async () => {
  await cdp.evaluate(`(() => {
    localStorage.removeItem('meeting-demo.draft.v1');
    localStorage.setItem('meeting-demo.history.v1', '[]');
    window.__draftRecoveryStartReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftRecoveryStartReloadMarker === undefined && Boolean(document.querySelector('[data-testid="new-meeting-button"]'))`);

  const snapshot = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '刷新后恢复的会议';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '这段未归档逐字稿需要在刷新后恢复。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    return JSON.parse(localStorage.getItem('meeting-demo.draft.v1'));
  })()`);
  assert.ok(snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ['meetingId', 'savedAt', 'topic', 'transcript']);
  assert.equal(snapshot.topic, '刷新后恢复的会议');
  assert.equal(snapshot.transcript, '这段未归档逐字稿需要在刷新后恢复。');

  await cdp.evaluate(`(() => { window.__draftRecoveryRestoreReloadMarker = 'pre-reload'; location.reload(); })()`);
  await waitForPageValue(`window.__draftRecoveryRestoreReloadMarker === undefined && Boolean(document.querySelector('#draft-restore-dialog'))`);
  const prompted = await cdp.evaluate(`({
    dialogOpen: document.querySelector('#draft-restore-dialog')?.open,
    topic: document.querySelector('#meeting-topic').value,
    transcript: document.querySelector('#transcript').value,
    focusedId: document.activeElement?.id
  })`);
  assert.equal(prompted.dialogOpen, true);
  assert.notEqual(prompted.transcript, snapshot.transcript);
  assert.equal(prompted.focusedId, 'restore-draft-button');

  await cdp.evaluate(`document.querySelector('#restore-draft-button').click()`);
  await waitForPageValue(`!document.querySelector('#draft-restore-dialog')?.open && document.querySelector('#transcript').value === '这段未归档逐字稿需要在刷新后恢复。'`);
  const restored = await cdp.evaluate(`({
    topic: document.querySelector('#meeting-topic').value,
    transcript: document.querySelector('#transcript').value,
    minutesMeta: document.querySelector('#minutes-meta').textContent.trim(),
    recordStatus: document.querySelector('[data-testid="record-status"]').textContent.trim(),
    historyCount: Number(document.querySelector('#history-count').textContent)
  })`);
  assert.equal(restored.topic, snapshot.topic);
  assert.equal(restored.transcript, snapshot.transcript);
  assert.match(restored.minutesMeta, /等待重新生成/);
  assert.doesNotMatch(restored.recordStatus, /录音中|转写中/);
  assert.equal(restored.historyCount, 0);
});

test('does not offer a discarded local draft again after reload', async () => {
  const savedAt = '2026-11-10T09:30:00.000Z';
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.draft.v1', JSON.stringify({ meetingId:'discarded-draft', topic:'将被放弃的草稿', transcript:'这份草稿不应再次出现。', savedAt:'${savedAt}' }));
    localStorage.setItem('meeting-demo.history.v1', '[]');
    window.__draftDiscardReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftDiscardReloadMarker === undefined && Boolean(document.querySelector('#meeting-topic'))`);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('#draft-restore-dialog')?.open)`), true);

  await cdp.evaluate(`document.querySelector('#discard-recovered-draft-button').click()`);
  await waitForPageValue(`!document.querySelector('#draft-restore-dialog')?.open && localStorage.getItem('meeting-demo.draft.v1') === null`);
  await cdp.evaluate(`(() => { window.__draftDiscardedReloadMarker = 'pre-reload'; location.reload(); })()`);
  await waitForPageValue(`window.__draftDiscardedReloadMarker === undefined && Boolean(document.querySelector('#meeting-topic'))`);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('#draft-restore-dialog')?.open)`), false);
});

test('ignores noncanonical local draft timestamps', async () => {
  await prepareCleanDraftPage();
  for (const [index, savedAt] of ['1', '2026-02-30T09:30:00.000Z'].entries()) {
    const rawSnapshot = JSON.stringify({ meetingId:`noncanonical-${index}`, topic:'不应恢复的时间', transcript:'宽松日期解析不能作为恢复依据。', savedAt });
    await cdp.evaluate(`(() => {
      localStorage.setItem('meeting-demo.history.v1', '[]');
      localStorage.setItem('meeting-demo.draft.v1', ${JSON.stringify(rawSnapshot)});
      window.__noncanonicalDraftReloadMarker = 'pre-reload';
      location.reload();
    })()`);
    await waitForPageValue(`window.__noncanonicalDraftReloadMarker === undefined && Boolean(document.querySelector('#meeting-topic'))`);
    const result = await cdp.evaluate(`({
      dialogOpen: Boolean(document.querySelector('#draft-restore-dialog')?.open),
      stored: localStorage.getItem('meeting-demo.draft.v1')
    })`);
    assert.equal(result.dialogOpen, false, `unexpected recovery prompt for ${savedAt}`);
    assert.equal(result.stored, rawSnapshot);
  }
});

test('keeps the recovery dialog open when discard recovered draft fails', async () => {
  await prepareCleanDraftPage();
  const rawSnapshot = JSON.stringify({ meetingId:'blocked-discard', topic:'删除失败的草稿', transcript:'删除本机草稿失败时应保留恢复选择。', savedAt:'2026-11-10T09:30:00.000Z' });
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    localStorage.setItem('meeting-demo.draft.v1', ${JSON.stringify(rawSnapshot)});
    window.__blockedDiscardReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__blockedDiscardReloadMarker === undefined && document.querySelector('#draft-restore-dialog')?.open === true`);

  const failed = await cdp.evaluate(`(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'removeItem');
    Object.defineProperty(Storage.prototype, 'removeItem', {
      ...descriptor,
      value(key) {
        if (key === 'meeting-demo.draft.v1') throw new Error('draft deletion blocked');
        return descriptor.value.call(this, key);
      }
    });
    try {
      document.querySelector('#discard-recovered-draft-button').click();
      const dialog = document.querySelector('#draft-restore-dialog');
      const status = dialog?.querySelector('#draft-restore-status');
      return {
        dialogOpen: dialog?.open,
        status: status?.textContent.trim(),
        statusInsideDialog: Boolean(status && dialog.contains(status)),
        statusRole: status?.getAttribute('role'),
        statusLive: status?.getAttribute('aria-live'),
        statusAtomic: status?.getAttribute('aria-atomic'),
        stored: localStorage.getItem('meeting-demo.draft.v1')
      };
    } finally {
      Object.defineProperty(Storage.prototype, 'removeItem', descriptor);
    }
  })()`);
  assert.equal(failed.dialogOpen, true);
  assert.match(failed.status, /无法删除|仍可能保存在当前浏览器/);
  assert.equal(failed.statusInsideDialog, true);
  assert.equal(failed.statusRole, 'status');
  assert.equal(failed.statusLive, 'polite');
  assert.equal(failed.statusAtomic, 'true');
  assert.equal(failed.stored, rawSnapshot);

  await cdp.evaluate(`document.querySelector('#discard-recovered-draft-button').click()`);
  await waitForPageValue(`!document.querySelector('#draft-restore-dialog')?.open && localStorage.getItem('meeting-demo.draft.v1') === null`);
});

test('explains a missing recovery draft before the user discards it', async () => {
  await prepareCleanDraftPage();
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    localStorage.setItem('meeting-demo.draft.v1', JSON.stringify({ meetingId:'already-missing', topic:'已被删除', transcript:'其他标签页已经移除了这份草稿。', savedAt:'2026-11-10T09:30:00.000Z' }));
    window.__missingDraftReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__missingDraftReloadMarker === undefined && document.querySelector('#draft-restore-dialog')?.open === true`);

  const result = await cdp.evaluate(`(() => {
    localStorage.removeItem('meeting-demo.draft.v1');
    document.querySelector('#discard-recovered-draft-button').click();
    window.dispatchEvent(new Event('pagehide'));
    return {
      dialogOpen: document.querySelector('#draft-restore-dialog')?.open,
      feedback: document.querySelector('#feedback').textContent.trim(),
      storedAfterPagehide: localStorage.getItem('meeting-demo.draft.v1')
    };
  })()`);
  assert.equal(result.dialogOpen, false);
  assert.match(result.feedback, /已不存在|已经不存在/);
  assert.equal(result.storedAfterPagehide, null);
});

test('preserves a foreign recovery draft replacement when the older prompt is discarded', async () => {
  await prepareCleanDraftPage();
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    localStorage.setItem('meeting-demo.draft.v1', JSON.stringify({ meetingId:'older-recovery', topic:'旧草稿', transcript:'这份提示将在另一标签页写入后过期。', savedAt:'2026-11-10T09:30:00.000Z' }));
    window.__foreignDraftReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__foreignDraftReloadMarker === undefined && document.querySelector('#draft-restore-dialog')?.open === true`);

  const foreignSnapshot = JSON.stringify({ meetingId:'other-tab-draft', topic:'另一标签页的草稿', transcript:'不能被旧恢复框删除。', savedAt:'2026-11-10T09:31:00.000Z' });
  const result = await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.draft.v1', ${JSON.stringify(foreignSnapshot)});
    document.querySelector('#discard-recovered-draft-button').click();
    return {
      dialogOpen: document.querySelector('#draft-restore-dialog')?.open,
      feedback: document.querySelector('#feedback').textContent.trim(),
      stored: localStorage.getItem('meeting-demo.draft.v1')
    };
  })()`);
  assert.equal(result.dialogOpen, false);
  assert.match(result.feedback, /另一标签页|已替换/);
  assert.equal(result.stored, foreignSnapshot);
});

test('keeps the current meeting when New Meeting cannot clear its recovery copy', async () => {
  await prepareCleanDraftPage();
  const result = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '仍需保留的会议';
    topic.dispatchEvent(new Event('input', { bubbles:true }));
    transcript.value = '无法删除本机恢复副本时，不应重置当前工作区。';
    transcript.dispatchEvent(new Event('input', { bubbles:true }));
    window.dispatchEvent(new Event('pagehide'));
    const draftBeforeReset = localStorage.getItem('meeting-demo.draft.v1');
    const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'removeItem');
    Object.defineProperty(Storage.prototype, 'removeItem', {
      ...descriptor,
      value(key) {
        if (key === 'meeting-demo.draft.v1') throw new Error('draft deletion blocked');
        return descriptor.value.call(this, key);
      }
    });
    try {
      document.querySelector('[data-testid="new-meeting-button"]').click();
      document.querySelector('#discard-draft-button').click();
      return {
        topic: topic.value,
        transcript: transcript.value,
        feedback: document.querySelector('#feedback').textContent.trim(),
        stored: localStorage.getItem('meeting-demo.draft.v1'),
        draftBeforeReset
      };
    } finally {
      Object.defineProperty(Storage.prototype, 'removeItem', descriptor);
    }
  })()`);
  assert.equal(result.topic, '仍需保留的会议');
  assert.equal(result.transcript, '无法删除本机恢复副本时，不应重置当前工作区。');
  assert.match(result.feedback, /无法清除本机草稿|当前会议仍保留/);
  assert.equal(result.stored, result.draftBeforeReset);
});

test('clears the matching local draft after a completed archive', async () => {
  await prepareCleanDraftPage();
  await cdp.evaluate(`(() => {
    localStorage.removeItem('meeting-demo.draft.v1');
    localStorage.setItem('meeting-demo.history.v1', '[]');
    window.__draftArchiveReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftArchiveReloadMarker === undefined && Boolean(document.querySelector('[data-testid="generate-button"]'))`);

  const beforeArchive = await cdp.evaluate(`(() => {
    const transcript = document.querySelector('#transcript');
    transcript.value = '归档后不应再保留恢复快照。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    return localStorage.getItem('meeting-demo.draft.v1');
  })()`);
  assert.ok(beforeArchive);
  const archived = await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="generate-button"]').click();
    return {
      draft: localStorage.getItem('meeting-demo.draft.v1'),
      historyCount: Number(document.querySelector('#history-count').textContent)
    };
  })()`);
  assert.equal(archived.historyCount, 1);
  assert.equal(archived.draft, null);
});

test('ignores malformed and foreign local draft storage without overwriting the active draft', async () => {
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.draft.v1', '{not valid json');
    window.__draftMalformedReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftMalformedReloadMarker === undefined && Boolean(document.querySelector('#transcript'))`);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('#draft-restore-dialog')?.open)`), false);

  const retained = await cdp.evaluate(`(() => {
    const transcript = document.querySelector('#transcript');
    transcript.value = '当前标签页的草稿不能被外部快照覆盖。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'meeting-demo.draft.v1',
      newValue: JSON.stringify({ meetingId:'other-tab', topic:'其他标签页', transcript:'不应覆盖', savedAt:'2026-11-10T09:30:00.000Z' }),
      storageArea: localStorage
    }));
    return transcript.value;
  })()`);
  assert.equal(retained, '当前标签页的草稿不能被外部快照覆盖。');
});

test('restores edits made after an archived meeting even when its ID matches history', async () => {
  await prepareCleanDraftPage();
  await cdp.evaluate(`(() => {
    const minutes = { overview:'已归档的纪要。', conclusions:[], actions:[], questions:[] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id:'edited-after-archive', topic:'已归档会议', transcript:'已归档的逐字稿。', savedAt:'2026-11-10T09:00:00.000Z', minutes }
    ]));
    localStorage.setItem('meeting-demo.draft.v1', JSON.stringify({
      meetingId:'edited-after-archive', topic:'已归档会议', transcript:'已归档后新增的修订逐字稿。', savedAt:'2026-11-10T10:00:00.000Z'
    }));
    window.__draftArchiveEditReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftArchiveEditReloadMarker === undefined && Boolean(document.querySelector('#meeting-topic'))`);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('#draft-restore-dialog')?.open)`), true);
  await cdp.evaluate(`document.querySelector('#restore-draft-button').click()`);
  await waitForPageValue(`document.querySelector('#transcript').value === '已归档后新增的修订逐字稿。'`);
  assert.equal(await cdp.evaluate(`document.querySelector('#transcript').value`), '已归档后新增的修订逐字稿。');
});

test('keeps the local draft recovery dialog open when Escape is pressed', async () => {
  await prepareCleanDraftPage();
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    localStorage.setItem('meeting-demo.draft.v1', JSON.stringify({ meetingId:'escape-recovery', topic:'等待恢复', transcript:'Escape 不应静默关闭恢复选择。', savedAt:'2026-11-10T10:00:00.000Z' }));
    window.__draftEscapeReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__draftEscapeReloadMarker === undefined && document.querySelector('#draft-restore-dialog')?.open === true`);
  await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
  await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await cdp.evaluate(`document.querySelector('#draft-restore-dialog')?.open`), true);
});

test('keeps the last valid local draft when newer text exceeds the recovery limit', async () => {
  await prepareCleanDraftPage();
  const retained = await cdp.evaluate(`(() => {
    const transcript = document.querySelector('#transcript');
    transcript.value = '可恢复的旧版本。';
    transcript.dispatchEvent(new Event('input', { bubbles:true }));
    window.dispatchEvent(new Event('pagehide'));
    transcript.value = '长'.repeat(200001);
    transcript.dispatchEvent(new Event('input', { bubbles:true }));
    window.dispatchEvent(new Event('pagehide'));
    return JSON.parse(localStorage.getItem('meeting-demo.draft.v1'))?.transcript;
  })()`);
  assert.equal(retained, '可恢复的旧版本。');
});

test('requires confirmation before a failed archive can discard its recovery copy', async () => {
  await prepareCleanDraftPage();
  const result = await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    const originalSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, 'setItem', {
      configurable:true,
      writable:true,
      value(key, value) {
        if (key === 'meeting-demo.history.v1') throw new Error('history persistence blocked');
        return originalSetItem.call(this, key, value);
      }
    });
    try {
      const transcript = document.querySelector('#transcript');
      transcript.value = '历史保存失败后仍需保护的草稿。';
      transcript.dispatchEvent(new Event('input', { bubbles:true }));
      document.querySelector('[data-testid="generate-button"]').click();
    } finally {
      Object.defineProperty(Storage.prototype, 'setItem', { configurable:true, writable:true, value:originalSetItem });
    }
    document.querySelector('[data-testid="new-meeting-button"]').click();
    return {
      dialogOpen: Boolean(document.querySelector('#discard-draft-dialog')?.open),
      recoverySnapshot: localStorage.getItem('meeting-demo.draft.v1')
    };
  })()`);
  assert.equal(result.dialogOpen, true);
  assert.ok(result.recoverySnapshot);
});

test('does not restart an exhausted local demo or leave its timer running', async () => {
  await cdp.evaluate(`(() => {
    document.querySelector('#reset-button').click();
    document.querySelector('[data-testid="record-button"]').click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 13_200));
  const exhausted = await cdp.evaluate(`({
    status: document.querySelector('[data-testid="record-status"]').textContent.trim(),
    elapsed: document.querySelector('[data-testid="elapsed"]').textContent.trim()
  })`);
  assert.match(exhausted.status, /已暂停/);

  await cdp.evaluate(`document.querySelector('[data-testid="record-button"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const afterRestartAttempt = await cdp.evaluate(`({
    status: document.querySelector('[data-testid="record-status"]').textContent.trim(),
    elapsed: document.querySelector('[data-testid="elapsed"]').textContent.trim()
  })`);
  assert.match(afterRestartAttempt.status, /已暂停/);
  assert.equal(afterRestartAttempt.elapsed, exhausted.elapsed);
});

test('history preserves completed meetings and displays one without changing the active draft', async () => {
  const controls = await cdp.evaluate(`({
    hasHistoryButton: Boolean(document.querySelector('[data-testid="history-button"]')),
    hasHistoryDialog: Boolean(document.querySelector('#history-dialog')),
    hasNewMeetingButton: Boolean(document.querySelector('[data-testid="new-meeting-button"]'))
  })`);
  assert.equal(controls.hasHistoryButton, true);
  assert.equal(controls.hasHistoryDialog, true);
  assert.equal(controls.hasNewMeetingButton, true);

  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    location.reload();
  })()`);
  await waitForPageValue(`Boolean(document.querySelector('[data-testid="history-button"]'))`);

  const savedCounts = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '预算评审';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '第一行\\n第二行';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="generate-button"]').click();
    const firstCount = document.querySelectorAll('[data-history-id]').length;
    document.querySelector('[data-testid="generate-button"]').click();
    return { firstCount, secondCount: document.querySelectorAll('[data-history-id]').length };
  })()`);
  assert.deepEqual(savedCounts, { firstCount: 1, secondCount: 1 });

  await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    document.querySelector('[data-testid="new-meeting-button"]').click();
    topic.value = '发布复盘';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '发布结论';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="generate-button"]').click();
    transcript.value = '未保存的当前草稿';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="history-button"]').click();
    const target = [...document.querySelectorAll('[data-history-id]')].find((button) => button.textContent.includes('预算评审'));
    target.click();
  })()`);

  const viewing = await cdp.evaluate(`({
    count: document.querySelectorAll('[data-history-id]').length,
    historyTranscript: document.querySelector('#history-transcript').value,
    overview: document.querySelector('#history-overview').textContent.trim(),
    currentTranscript: document.querySelector('#transcript').value
  })`);
  assert.equal(viewing.count, 2);
  assert.equal(viewing.historyTranscript, '第一行\n第二行');
  assert.match(viewing.overview, /第一行/);
  assert.equal(viewing.currentTranscript, '未保存的当前草稿');

  await cdp.evaluate(`(() => { window.__historyReloadMarker = 'pre-reload'; location.reload(); })()`);
  await waitForPageValue(`window.__historyReloadMarker === undefined && Boolean(document.querySelector('[data-testid="history-button"]'))`);
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="history-button"]').click();
    const target = [...document.querySelectorAll('[data-history-id]')].find((button) => button.textContent.includes('预算评审'));
    target.click();
  })()`);
  const afterReload = await cdp.evaluate(`({
    count: document.querySelectorAll('[data-history-id]').length,
    historyTranscript: document.querySelector('#history-transcript').value,
    overview: document.querySelector('#history-overview').textContent.trim()
  })`);
  assert.equal(afterReload.count, 2);
  assert.equal(afterReload.historyTranscript, '第一行\n第二行');
  assert.match(afterReload.overview, /第一行/);
});

test('merges a newer local history snapshot before archiving the current meeting', async () => {
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    window.__historyMergeReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyMergeReloadMarker === undefined && Number(document.querySelector('#history-count').textContent) === 0`);

  const result = await cdp.evaluate(`(() => {
    const minutes = { overview: '外部标签页已经保存的纪要。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'external-history', topic: '外部会议', savedAt: '2026-03-04T09:00:00.000Z', transcript: '另一标签页先保存的逐字稿。', minutes }
    ]));
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '本页会议';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '本页随后生成的逐字稿。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="generate-button"]').click();
    return {
      storedTopics: JSON.parse(localStorage.getItem('meeting-demo.history.v1')).map((record) => record.topic).sort(),
      count: Number(document.querySelector('#history-count').textContent),
      draft: transcript.value,
      topic: topic.value
    };
  })()`);
  assert.deepEqual(result.storedTopics, ['外部会议', '本页会议']);
  assert.equal(result.count, 2);
  assert.equal(result.draft, '本页随后生成的逐字稿。');
  assert.equal(result.topic, '本页会议');
});

test('refreshes local history after a same-origin storage event without changing the draft', async () => {
  await cdp.evaluate(`(() => {
    const minutes = { overview: '已有会议。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'existing-history', topic: '已有会议', savedAt: '2026-03-03T09:00:00.000Z', transcript: '已有逐字稿。', minutes }
    ]));
    window.__historyEventReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyEventReloadMarker === undefined && Number(document.querySelector('#history-count').textContent) === 1`);

  const result = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '不应修改的主题';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '不应修改的当前草稿。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="history-button"]').click();
    const filter = document.querySelector('#history-filter');
    filter.value = '外部';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    const oldValue = localStorage.getItem('meeting-demo.history.v1');
    const minutes = { overview: '外部同步会议的概览。', conclusions: [], actions: [], questions: [] };
    const nextValue = JSON.stringify([
      ...JSON.parse(oldValue),
      { id: 'external-event-history', topic: '外部同步会议', savedAt: '2026-03-04T09:00:00.000Z', transcript: '外部标签页更新的逐字稿。', minutes }
    ]);
    window.__historyEventFetchCalls = [];
    window.fetch = (...args) => {
      window.__historyEventFetchCalls.push(args);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    localStorage.setItem('meeting-demo.history.v1', nextValue);
    window.dispatchEvent(new StorageEvent('storage', { key: 'meeting-demo.history.v1', oldValue, newValue: nextValue, storageArea: localStorage, url: location.href }));
    return {
      count: Number(document.querySelector('#history-count').textContent),
      topics: [...document.querySelectorAll('[data-history-id] .history-record-topic')].map((topic) => topic.textContent.trim()),
      selected: document.querySelector('#history-topic').textContent.trim(),
      query: filter.value,
      draft: transcript.value,
      topic: topic.value,
      fetchCalls: window.__historyEventFetchCalls.length
    };
  })()`);
  assert.equal(result.count, 2);
  assert.deepEqual(result.topics, ['外部同步会议']);
  assert.equal(result.selected, '外部同步会议');
  assert.equal(result.query, '外部');
  assert.equal(result.draft, '不应修改的当前草稿。');
  assert.equal(result.topic, '不应修改的主题');
  assert.equal(result.fetchCalls, 0);
});

test('respects an externally cleared local history', async () => {
  await cdp.evaluate(`(() => {
    const minutes = { overview: '会被外部清空的历史。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'clear-history', topic: '待清空会议', savedAt: '2026-03-03T09:00:00.000Z', transcript: '待清空逐字稿。', minutes }
    ]));
    window.__historyClearReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyClearReloadMarker === undefined && Number(document.querySelector('#history-count').textContent) === 1`);

  const result = await cdp.evaluate(`(() => {
    const oldValue = localStorage.getItem('meeting-demo.history.v1');
    localStorage.removeItem('meeting-demo.history.v1');
    window.dispatchEvent(new StorageEvent('storage', { key: null, oldValue, newValue: null, storageArea: localStorage, url: location.href }));
    return {
      count: Number(document.querySelector('#history-count').textContent),
      list: document.querySelector('#history-list').textContent.trim()
    };
  })()`);
  assert.equal(result.count, 0);
  assert.match(result.list, /还没有历史会议/);
});

test('keeps local history when a remote payload is not an array', async () => {
  await cdp.evaluate(`(() => {
    const minutes = { overview: '需要保留的历史。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'valid-history', topic: '保留会议', savedAt: '2026-03-03T09:00:00.000Z', transcript: '保留逐字稿。', minutes }
    ]));
    window.__historyMalformedEventReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyMalformedEventReloadMarker === undefined && Number(document.querySelector('#history-count').textContent) === 1`);

  const result = await cdp.evaluate(`(() => {
    const oldValue = localStorage.getItem('meeting-demo.history.v1');
    const newValue = JSON.stringify({ unexpected: 'not a history array' });
    localStorage.setItem('meeting-demo.history.v1', newValue);
    window.dispatchEvent(new StorageEvent('storage', { key: 'meeting-demo.history.v1', oldValue, newValue, storageArea: localStorage, url: location.href }));
    return {
      count: Number(document.querySelector('#history-count').textContent),
      topics: [...document.querySelectorAll('[data-history-id] .history-record-topic')].map((topic) => topic.textContent.trim())
    };
  })()`);
  assert.equal(result.count, 1);
  assert.deepEqual(result.topics, ['保留会议']);
});

test('keeps a pending in-memory record when storage recovers', async () => {
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '[]');
    window.__historyRecoveryReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyRecoveryReloadMarker === undefined && Number(document.querySelector('#history-count').textContent) === 0`);

  const result = await cdp.evaluate(`(() => {
    const originalSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, 'setItem', {
      configurable: true,
      writable: true,
      value(key, value) {
        if (key === 'meeting-demo.history.v1') throw new Error('temporary history storage failure');
        return originalSetItem.call(this, key, value);
      }
    });
    try {
      const topic = document.querySelector('#meeting-topic');
      const transcript = document.querySelector('#transcript');
      topic.value = '仅内存会议';
      topic.dispatchEvent(new Event('input', { bubbles: true }));
      transcript.value = '第一次保存暂时失败。';
      transcript.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-testid="generate-button"]').click();
    } finally {
      Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, writable: true, value: originalSetItem });
    }
    const externalMinutes = { overview: '存储恢复后另一标签页的历史。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'recovery-external', topic: '恢复后的外部会议', savedAt: '2026-03-04T09:00:00.000Z', transcript: '外部记录。', minutes: externalMinutes }
    ]));
    document.querySelector('[data-testid="new-meeting-button"]').click();
    document.querySelector('#discard-draft-button')?.click();
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '恢复后本页会议';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '第二次保存成功。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="generate-button"]').click();
    return JSON.parse(localStorage.getItem('meeting-demo.history.v1')).map((record) => record.topic).sort();
  })()`);
  assert.equal(result.length, 3);
  assert.ok(result.includes('仅内存会议'));
  assert.ok(result.includes('恢复后的外部会议'));
  assert.ok(result.includes('恢复后本页会议'));
});

test('filters local history without changing storage or the active draft', async () => {
  await cdp.evaluate(`(() => {
    const minutes = { overview: '已保存的本地纪要。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'product-review', topic: '产品评审', savedAt: '2026-03-03T09:00:00.000Z', transcript: '讨论新手引导与激活率。', minutes },
      { id: 'budget-review', topic: '预算评审', savedAt: '2026-03-02T09:00:00.000Z', transcript: '审议 Q4 成本控制方案。', minutes },
      { id: 'weekly-sync', topic: '周会同步', savedAt: '2026-03-01T09:00:00.000Z', transcript: '王敏需要确认预算调整。', minutes }
    ]));
    location.reload();
  })()`);
  await waitForPageValue(`Boolean(document.querySelector('[data-testid="history-button"]'))`);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('#history-filter'))`), true);

  await cdp.evaluate(`(() => {
    const transcript = document.querySelector('#transcript');
    document.querySelector('#meeting-topic').value = '当前草稿';
    transcript.value = '未保存的当前草稿';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="history-button"]').click();
  })()`);
  const beforeFilter = await cdp.evaluate(`({
    selected: document.querySelector('#history-topic').textContent.trim(),
    stored: localStorage.getItem('meeting-demo.history.v1'),
    draft: document.querySelector('#transcript').value
  })`);
  assert.equal(beforeFilter.selected, '产品评审');
  assert.equal(beforeFilter.draft, '未保存的当前草稿');

  await cdp.evaluate(`(() => {
    const filter = document.querySelector('#history-filter');
    filter.value = '成本控制';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const filtered = await cdp.evaluate(`({
    topics: [...document.querySelectorAll('[data-history-id]')].map((button) => button.textContent.trim()),
    selected: document.querySelector('#history-topic').textContent.trim(),
    label: document.querySelector('#history-list-label').textContent.trim(),
    stored: localStorage.getItem('meeting-demo.history.v1'),
    draft: document.querySelector('#transcript').value
  })`);
  assert.equal(filtered.topics.length, 1);
  assert.match(filtered.topics[0], /预算评审/);
  assert.equal(filtered.selected, '预算评审');
  assert.match(filtered.label, /匹配 1 \/ 3/);
  assert.equal(filtered.stored, beforeFilter.stored);
  assert.equal(filtered.draft, beforeFilter.draft);

  await cdp.evaluate(`(() => {
    const filter = document.querySelector('#history-filter');
    filter.value = '不存在的会议';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const noMatch = await cdp.evaluate(`({
    empty: document.querySelector('#history-list').textContent.trim(),
    detail: document.querySelector('#history-topic').textContent.trim(),
    stored: localStorage.getItem('meeting-demo.history.v1')
  })`);
  assert.match(noMatch.empty, /未找到匹配的本地历史会议/);
  assert.match(noMatch.detail, /未找到匹配的本地历史会议/);
  assert.equal(noMatch.stored, beforeFilter.stored);

  await cdp.evaluate(`(() => {
    const filter = document.querySelector('#history-filter');
    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const restored = await cdp.evaluate(`({
    count: document.querySelectorAll('[data-history-id]').length,
    selected: document.querySelector('#history-topic').textContent.trim(),
    draft: document.querySelector('#transcript').value
  })`);
  assert.equal(restored.count, 3);
  assert.equal(restored.selected, '产品评审');
  assert.equal(restored.draft, beforeFilter.draft);
});

test('exports the displayed local history without changing the draft or storage', async () => {
  await cdp.evaluate(`(() => {
    const minutes = {
      overview: '这是已保存历史记录的概览。',
      conclusions: ['仅导出历史中的结论。'],
      actions: [{ task: '归档评审结果', owner: '陈琳', due: '周五' }],
      questions: []
    };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'architecture-review', topic: '架构评审', savedAt: '2026-03-03T09:00:00.000Z', transcript: '讨论缓存层设计。', minutes },
      { id: 'budget-review', topic: '预算复盘', savedAt: '2026-03-02T09:00:00.000Z', transcript: '历史导出目标记录，包含成本说明。', minutes }
    ]));
    window.__historyExportReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyExportReloadMarker === undefined && document.querySelectorAll('[data-history-id]').length === 2`);

  const before = await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '当前草稿主题';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '不可导出的当前草稿。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="history-button"]').click();
    const filter = document.querySelector('#history-filter');
    filter.value = '历史导出目标记录';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    window.__historyExportCapture = {};
    window.__historyExportFetchCalls = [];
    window.fetch = (...args) => {
      window.__historyExportFetchCalls.push(args);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    URL.createObjectURL = (blob) => {
      window.__historyExportCapture.blob = blob;
      return 'blob:history-export';
    };
    HTMLAnchorElement.prototype.click = function click() {
      window.__historyExportCapture.fileName = this.download;
    };
    return {
      storage: localStorage.getItem('meeting-demo.history.v1'),
      draft: transcript.value,
      displayedTopic: document.querySelector('#history-topic').textContent.trim()
    };
  })()`);
  assert.equal(before.displayedTopic, '预算复盘');

  await cdp.evaluate(`document.querySelector('#history-export-button').click()`);
  const exported = await cdp.evaluate(`(async () => ({
    fileName: window.__historyExportCapture.fileName,
    content: await window.__historyExportCapture.blob.text(),
    storage: localStorage.getItem('meeting-demo.history.v1'),
    draft: document.querySelector('#transcript').value,
    fetchCalls: window.__historyExportFetchCalls.length,
    historyStatus: document.querySelector('#history-export-status').textContent.trim()
  }))()`);

  assert.match(exported.fileName, /^预算复盘-会议纪要\.md$/);
  assert.match(exported.content, /# 预算复盘 · 会议纪要/);
  assert.match(exported.content, /这是已保存历史记录的概览。/);
  assert.match(exported.content, /历史导出目标记录，包含成本说明。/);
  assert.doesNotMatch(exported.content, /不可导出的当前草稿/);
  assert.equal(exported.storage, before.storage);
  assert.equal(exported.draft, before.draft);
  assert.equal(exported.fetchCalls, 0);
  assert.match(exported.historyStatus, /已导出历史会议纪要/);
});

test('disables history export without a visible record and explains blocked downloads', async () => {
  await cdp.evaluate(`(() => {
    const minutes = { overview: '用于下载失败提示的历史纪要。', conclusions: [], actions: [], questions: [] };
    localStorage.setItem('meeting-demo.history.v1', JSON.stringify([
      { id: 'blocked-export-record', topic: '预算复盘', savedAt: '2026-03-02T09:00:00.000Z', transcript: '历史导出目标记录，包含成本说明。', minutes }
    ]));
    window.__historyExportBlockedReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyExportBlockedReloadMarker === undefined && document.querySelectorAll('[data-history-id]').length === 1`);
  await cdp.evaluate(`document.querySelector('[data-testid="history-button"]').click()`);

  const blocked = await cdp.evaluate(`(() => {
    const filter = document.querySelector('#history-filter');
    filter.value = '不存在的本地记录';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#history-export-button').disabled;
  })()`);
  assert.equal(blocked, true);

  const feedback = await cdp.evaluate(`(() => {
    const filter = document.querySelector('#history-filter');
    filter.value = '历史导出目标记录';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    URL.createObjectURL = () => { throw new Error('download blocked'); };
    document.querySelector('#history-export-button').click();
    return {
      footer: document.querySelector('#feedback').textContent.trim(),
      historyStatus: document.querySelector('#history-export-status').textContent.trim()
    };
  })()`);
  assert.match(feedback.footer, /浏览器未允许自动下载/);
  assert.match(feedback.historyStatus, /浏览器未允许自动下载/);
});

test('warns and falls back to sample history after malformed persisted data', async () => {
  await cdp.evaluate(`(() => {
    localStorage.setItem('meeting-demo.history.v1', '{not valid json');
    window.__historyParseReloadMarker = 'pre-reload';
    location.reload();
  })()`);
  await waitForPageValue(`window.__historyParseReloadMarker === undefined && Boolean(document.querySelector('[data-testid="history-button"]'))`);
  const fallback = await cdp.evaluate(`({
    feedback: document.querySelector('#feedback').textContent.trim(),
    count: Number(document.querySelector('#history-count').textContent)
  })`);
  assert.match(fallback.feedback, /浏览器存储不可用.*当前页面/);
  assert.equal(fallback.count, 2);
});

test('keeps an in-memory save when browser storage writes fail', async () => {
  await cdp.evaluate(`localStorage.setItem('meeting-demo.history.v1', '[]')`);
  await cdp.send('Page.enable');
  const injection = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__historyWriteStorageHooked = true; Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('blocked storage write'); } });",
  });
  await cdp.evaluate(`location.reload()`);
  await waitForPageValue(`window.__historyWriteStorageHooked === true && Boolean(document.querySelector('[data-testid="history-button"]'))`);
  await cdp.evaluate(`(() => {
    const topic = document.querySelector('#meeting-topic');
    const transcript = document.querySelector('#transcript');
    topic.value = '写入失败回退';
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    transcript.value = '这条会议只保留在当前页面。';
    transcript.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="generate-button"]').click();
  })()`);
  const result = await cdp.evaluate(`({
    feedback: document.querySelector('#feedback').textContent.trim(),
    count: Number(document.querySelector('#history-count').textContent)
  })`);
  assert.match(result.feedback, /已生成纪要.*浏览器存储不可用.*当前页面/);
  assert.equal(result.count, 1);
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
});

test('explains the in-memory fallback when browser storage is unavailable', async () => {
  await cdp.send('Page.enable');
  const injection = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__historyStorageHooked = true; Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value: () => { throw new Error('blocked storage'); } }); Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('blocked storage'); } });",
  });
  await cdp.evaluate(`location.reload()`);
  await waitForPageValue(`window.__historyStorageHooked === true && Boolean(document.querySelector('[data-testid="history-button"]'))`);
  const fallback = await cdp.evaluate(`({
    hooked: window.__historyStorageHooked === true,
    getThrows: (() => { try { localStorage.getItem('history-probe'); return false; } catch (error) { return true; } })(),
    feedback: document.querySelector('#feedback').textContent.trim(),
    count: Number(document.querySelector('#history-count').textContent)
  })`);
  assert.equal(fallback.hooked, true);
  assert.equal(fallback.getThrows, true);
  assert.match(fallback.feedback, /浏览器存储不可用.*当前页面/);
  assert.equal(fallback.count, 2);
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
});

test('connection config keeps a typed key while delayed status resolves', async () => {
  await cdp.evaluate("(() => { window.__connectionRaceReloadMarker = 'pre-reload'; location.reload(); })()");
  await waitForPageValue("window.__connectionRaceReloadMarker === undefined && Boolean(document.querySelector('#settings-button'))");
  await cdp.evaluate("(() => { window.__connectionStatusResolved = false; window.fetch = async (url) => { if (url !== '/api/status') throw new Error('Unexpected fetch'); return new Promise((resolve) => { window.__resolveConnectionStatus = () => { window.__connectionStatusResolved = true; resolve(new Response(JSON.stringify({ configured: false, host: '', model: 'qwen-plus' }), { status: 200, headers: { 'content-type': 'application/json' } })); }; }); }; document.querySelector('#settings-button').click(); document.querySelector('#connection-api-key').value = 'delayed-browser-test-key'; })()");
  assert.equal(await cdp.evaluate("document.querySelector('#connection-api-key').value"), 'delayed-browser-test-key');
  await cdp.evaluate("window.__resolveConnectionStatus()");
  await waitForPageValue("window.__connectionStatusResolved === true && /本机配置服务/.test(document.querySelector('#connection-status').textContent)");
  assert.equal(await cdp.evaluate("document.querySelector('#connection-api-key').value"), 'delayed-browser-test-key');
});

test('connection config submits only to the loopback endpoint and never persists a key', async () => {
  await cdp.evaluate("(() => { window.__connectionConfigReloadMarker = 'pre-reload'; location.reload(); })()");
  await waitForPageValue("window.__connectionConfigReloadMarker === undefined && Boolean(document.querySelector('#settings-button'))");

  const controls = await cdp.evaluate("({ hasHost: Boolean(document.querySelector('#connection-host')), hasKey: Boolean(document.querySelector('#connection-api-key')), hasModel: Boolean(document.querySelector('#connection-model')), hasSave: Boolean(document.querySelector('#save-connection-button')), keyType: document.querySelector('#connection-api-key')?.type, keyAutocomplete: document.querySelector('#connection-api-key')?.autocomplete })");
  assert.equal(controls.hasHost, true);
  assert.equal(controls.hasKey, true);
  assert.equal(controls.hasModel, true);
  assert.equal(controls.hasSave, true);
  assert.equal(controls.keyType, 'password');
  assert.equal(controls.keyAutocomplete, 'off');

  await cdp.evaluate("(() => { window.__connectionCalls = []; window.fetch = async (url, options = {}) => { const target = typeof url === 'string' ? url : url.url; const method = options.method || 'GET'; window.__connectionCalls.push({ target, method, body: options.body || '' }); const payload = target === '/api/status' ? { configured: false, host: '', model: 'qwen-plus', asrEndpoint: '' } : target === '/api/config' ? { configured: true, host: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' } : { message: 'not found' }; return new Response(JSON.stringify(payload), { status: target === '/api/status' || target === '/api/config' ? 200 : 404, headers: { 'content-type': 'application/json' } }); }; document.querySelector('#settings-button').click(); })()");
  await waitForPageValue("document.querySelector('#connection-status').textContent.trim().length > 0");
  await cdp.evaluate("(() => { document.querySelector('#connection-host').value = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/'; document.querySelector('#connection-api-key').value = 'browser-test-key'; document.querySelector('#connection-model').value = 'qwen-plus'; document.querySelector('#save-connection-button').click(); })()");
  await waitForPageValue("document.querySelector('#connection-api-key').value === '' && /已保存本次配置/.test(document.querySelector('#connection-status').textContent)");

  const saved = await cdp.evaluate("({ calls: window.__connectionCalls.map(({ target, method, body }) => ({ target, method, bodyIncludesKey: body.includes('browser-test-key') })), keyStored: Object.keys(localStorage).some((key) => String(localStorage.getItem(key)).includes('browser-test-key')) })");
  assert.deepEqual(saved.calls, [
    { target: '/api/status', method: 'GET', bodyIncludesKey: false },
    { target: '/api/config', method: 'POST', bodyIncludesKey: true },
  ]);
  assert.equal(saved.keyStored, false);

  await cdp.evaluate("(() => { document.querySelector('#connection-host').value = 'ftp://invalid.example.test'; document.querySelector('#connection-api-key').value = 'another-browser-test-key'; document.querySelector('#save-connection-button').click(); })()");
  const invalid = await cdp.evaluate("({ callCount: window.__connectionCalls.length, message: document.querySelector('#connection-status').textContent.trim() })");
  assert.equal(invalid.callCount, 2);
  assert.match(invalid.message, /百炼|Base URL/);
});

test('configured Qwen generation submits only transcript data to the local minutes route', async () => {
  await cdp.evaluate("(() => { window.__qwenGenerationReloadMarker = 'pre-reload'; location.reload(); })()");
  await waitForPageValue("window.__qwenGenerationReloadMarker === undefined && Boolean(document.querySelector('#settings-button'))");
  await cdp.evaluate("(() => { window.__qwenCalls = []; window.fetch = async (url, options = {}) => { const target = typeof url === 'string' ? url : url.url; const method = options.method || 'GET'; window.__qwenCalls.push({ target, method, body: options.body || '' }); if (target === '/api/status') return new Response(JSON.stringify({ configured: true, host: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' }), { status: 200, headers: { 'content-type': 'application/json' } }); if (target === '/api/minutes') return new Response(JSON.stringify({ minutes: { overview: '千问已确认周三交付设计稿。', conclusions: ['先完成设计评审。'], actions: [{ task: '输出设计稿', owner: '王敏', due: '周三' }], questions: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }); return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }); }; document.querySelector('#settings-button').click(); })()");
  await waitForPageValue("window.__qwenCalls.some((call) => call.target === '/api/status') && /已配置/.test(document.querySelector('#connection-status').textContent)");
  await cdp.evaluate("document.querySelector('#close-dialog-button').click()");
  await cdp.evaluate("(() => { document.querySelector('#meeting-topic').value = '产品评审'; const transcript = document.querySelector('#transcript'); transcript.value = '王敏：周三前输出设计稿。'; transcript.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-testid=\"generate-button\"]').click(); })()");
  await waitForPageValue("document.querySelector('[data-testid=\"minutes-overview\"]').textContent.includes('千问已确认')");
  const result = await cdp.evaluate("({ calls: window.__qwenCalls.map((call) => ({ target: call.target, method: call.method, body: call.body })), overview: document.querySelector('[data-testid=\"minutes-overview\"]').textContent.trim(), source: document.querySelector('#minutes-meta').textContent.trim() })");
  assert.deepEqual(result.calls.map(({ target, method }) => ({ target, method })), [
    { target: '/api/status', method: 'GET' },
    { target: '/api/minutes', method: 'POST' },
  ]);
  assert.deepEqual(JSON.parse(result.calls[1].body), { topic: '产品评审', transcript: '王敏：周三前输出设计稿。' });
  assert.equal(result.overview, '千问已确认周三交付设计稿。');
  assert.match(result.source, /千问/);
});

test('configured recording reports microphone unavailability without substituting demo text', async () => {
  await cdp.evaluate("(() => { window.__asrModeReloadMarker = 'pre-reload'; location.reload(); })()");
  await waitForPageValue("window.__asrModeReloadMarker === undefined && Boolean(document.querySelector('#settings-button'))");
  await cdp.evaluate("(() => { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }); window.fetch = async (url) => { if (url !== '/api/status') throw new Error('Unexpected fetch: ' + url); return new Response(JSON.stringify({ configured: true, host: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' }), { status: 200, headers: { 'content-type': 'application/json' } }); }; document.querySelector('#settings-button').click(); })()");
  await waitForPageValue("/已配置/.test(document.querySelector('#connection-status').textContent)");
  await cdp.evaluate("document.querySelector('#close-dialog-button').click(); document.querySelector('[data-testid=\"record-button\"]').click()");
  await waitForPageValue("/麦克风/.test(document.querySelector('#feedback').textContent)");
  const result = await cdp.evaluate("({ label: document.querySelector('#record-label').textContent.trim(), transcript: document.querySelector('#transcript').value, feedback: document.querySelector('#feedback').textContent.trim(), recording: document.querySelector('[data-testid=\"record-status\"]').textContent.trim() })");
  assert.match(result.label, /真实录音/);
  assert.equal(result.transcript, '');
  assert.match(result.feedback, /麦克风/);
  assert.doesNotMatch(result.recording, /演示录音中/);
});

test('checks configured status during startup without requiring the settings dialog', async () => {
  await cdp.send('Page.enable');
  const injection = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__startupStatusCalls = []; window.fetch = async (url, options = {}) => { const target = typeof url === 'string' ? url : url.url; window.__startupStatusCalls.push({ target, method: options.method || 'GET' }); if (target !== '/api/status') throw new Error('Unexpected fetch: ' + target); return new Response(JSON.stringify({ configured: true, host: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' }), { status: 200, headers: { 'content-type': 'application/json' } }); };",
  });
  try {
    await cdp.evaluate("(() => { window.__startupReloadMarker = 'pre-reload'; location.reload(); })()");
    await waitForPageValue("window.__startupReloadMarker === undefined && window.__startupStatusCalls.length === 1");
    const result = await cdp.evaluate("({ calls: window.__startupStatusCalls, label: document.querySelector('#record-label').textContent.trim(), status: document.querySelector('[data-testid=\"record-status\"]').textContent.trim() })");
    assert.deepEqual(result.calls, [{ target: '/api/status', method: 'GET' }]);
    assert.match(result.label, /真实录音/);
    assert.match(result.status, /百炼已配置/);
  } finally {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
  }
});

test('discards a delayed Qwen result after a new meeting replaces its transcript', async () => {
  await cdp.evaluate("(() => { localStorage.setItem('meeting-demo.history.v1', '[]'); window.__qwenRaceReloadMarker = 'pre-reload'; location.reload(); })()");
  await waitForPageValue("window.__qwenRaceReloadMarker === undefined && Boolean(document.querySelector('#settings-button'))");
  await cdp.evaluate("(() => { window.__minutesCallCount = 0; window.fetch = async (url, options = {}) => { const target = typeof url === 'string' ? url : url.url; if (target === '/api/status') return new Response(JSON.stringify({ configured: true, host: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' }), { status: 200, headers: { 'content-type': 'application/json' } }); if (target === '/api/minutes') { window.__minutesCallCount += 1; return new Promise((resolve) => { window.__resolveDelayedMinutes = () => resolve(new Response(JSON.stringify({ minutes: { overview: 'A 的千问总结', conclusions: [], actions: [], questions: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })); }); } throw new Error('Unexpected fetch: ' + target); }; document.querySelector('#settings-button').click(); })()");
  await waitForPageValue("/已配置/.test(document.querySelector('#connection-status').textContent)");
  await cdp.evaluate("(() => { document.querySelector('#close-dialog-button').click(); document.querySelector('#meeting-topic').value = '会议 A'; const transcript = document.querySelector('#transcript'); transcript.value = '逐字稿 A'; transcript.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-testid=\"generate-button\"]').click(); })()");
  await waitForPageValue("window.__minutesCallCount === 1", 800);
  await cdp.evaluate("document.querySelector('[data-testid=\"new-meeting-button\"]').click()");
  await waitForPageValue("document.querySelector('#discard-draft-dialog')?.open === true");
  await cdp.evaluate("(() => { document.querySelector('#discard-draft-button').click(); document.querySelector('#meeting-topic').value = '会议 B'; const transcript = document.querySelector('#transcript'); transcript.value = '逐字稿 B'; transcript.dispatchEvent(new Event('input', { bubbles: true })); window.__resolveDelayedMinutes(); })()");
  await waitForPageValue("/已丢弃.*过期/.test(document.querySelector('#feedback').textContent)");
  const result = await cdp.evaluate("({ overview: document.querySelector('[data-testid=\"minutes-overview\"]').textContent.trim(), historyCount: document.querySelectorAll('[data-history-id]').length, transcript: document.querySelector('#transcript').value })");
  assert.doesNotMatch(result.overview, /A 的千问总结/);
  assert.equal(result.historyCount, 0);
  assert.equal(result.transcript, '逐字稿 B');
});

test('does not export a silent local summary after configured Qwen generation fails', async () => {
  await cdp.evaluate("(() => { window.__qwenExportReloadMarker = 'pre-reload'; location.reload(); })()");
  await waitForPageValue("window.__qwenExportReloadMarker === undefined && Boolean(document.querySelector('#settings-button'))");
  await cdp.evaluate("(() => { window.__exportMinuteCalls = 0; window.__exportCreated = false; URL.createObjectURL = () => { window.__exportCreated = true; return 'blob:should-not-export'; }; window.fetch = async (url) => { if (url === '/api/status') return new Response(JSON.stringify({ configured: true, host: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' }), { status: 200, headers: { 'content-type': 'application/json' } }); if (url === '/api/minutes') { window.__exportMinuteCalls += 1; return new Response(JSON.stringify({ message: '百炼请求失败' }), { status: 502, headers: { 'content-type': 'application/json' } }); } throw new Error('Unexpected fetch: ' + url); }; document.querySelector('#settings-button').click(); })()");
  await waitForPageValue("/已配置/.test(document.querySelector('#connection-status').textContent)");
  await cdp.evaluate("(() => { document.querySelector('#close-dialog-button').click(); const transcript = document.querySelector('#transcript'); transcript.value = '需要真实纪要的逐字稿。'; transcript.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-testid=\"generate-button\"]').click(); })()");
  await waitForPageValue("window.__exportMinuteCalls === 1", 800);
  await waitForPageValue("/未生成纪要/.test(document.querySelector('#feedback').textContent)");
  await cdp.evaluate("document.querySelector('[data-testid=\"export-button\"]').click()");
  const result = await cdp.evaluate("({ created: window.__exportCreated, feedback: document.querySelector('#feedback').textContent.trim() })");
  assert.equal(result.created, false);
  assert.match(result.feedback, /无法导出|重新生成/);
});

test('cancels a pending microphone permission request when a new meeting begins', async () => {
  await cdp.evaluate("(() => { window.__micCancelReloadMarker = 'pre-reload'; location.reload(); })()");
  await waitForPageValue("window.__micCancelReloadMarker === undefined && Boolean(document.querySelector('#settings-button'))");
  await cdp.evaluate("(() => { window.__micRequested = false; window.__stoppedTracks = 0; Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { window.__micRequested = true; return new Promise((resolve) => { window.__resolveMic = resolve; }); } } }); window.fetch = async (url) => { if (url !== '/api/status') throw new Error('Unexpected fetch: ' + url); return new Response(JSON.stringify({ configured: true, host: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference' }), { status: 200, headers: { 'content-type': 'application/json' } }); }; document.querySelector('#settings-button').click(); })()");
  await waitForPageValue("/已配置/.test(document.querySelector('#connection-status').textContent)");
  await cdp.evaluate("document.querySelector('#close-dialog-button').click(); document.querySelector('[data-testid=\"record-button\"]').click()");
  await waitForPageValue("window.__micRequested === true", 800);
  await cdp.evaluate("document.querySelector('[data-testid=\"new-meeting-button\"]').click()");
  await waitForPageValue("document.querySelector('#discard-draft-dialog')?.open === true");
  await cdp.evaluate("(() => { document.querySelector('#discard-draft-button').click(); window.__resolveMic({ getTracks: () => [{ stop: () => { window.__stoppedTracks += 1; } }] }); })()");
  await waitForPageValue("window.__stoppedTracks === 1");
  const result = await cdp.evaluate("({ label: document.querySelector('#record-label').textContent.trim(), status: document.querySelector('[data-testid=\"record-status\"]').textContent.trim(), transcript: document.querySelector('#transcript').value })");
  assert.match(result.label, /开始真实录音/);
  assert.doesNotMatch(result.status, /真实录音中|Paraformer 正在转写/);
  assert.equal(result.transcript, '');
});
