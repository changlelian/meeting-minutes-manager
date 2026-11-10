import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createDesktopRuntime } from '../desktop/runtime.mjs';
import { DESKTOP_CAPABILITY_HEADER } from '../server.mjs';

const origin = 'http://127.0.0.1:4174';
const wsUrl = 'ws://127.0.0.1:4174/api/asr-stream';

test('the Windows package resolves the desktop entry and ships its runtime assets', async () => {
  const manifestUrl = new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.main, 'desktop/main.mjs', 'Electron must resolve the main-process entry');
  assert.equal(manifest.scripts.desktop, 'electron .');
  assert.equal(manifest.scripts['desktop:pack'], 'electron-builder --win --dir');
  assert.equal(manifest.scripts['desktop:dist'], 'electron-builder --win');
  assert.equal(manifest.build?.asar, true);
  assert.deepEqual(manifest.build.win.target, ['nsis']);
  assert.match(manifest.build.nsis.artifactName, /^MeetingMinutes-Setup-/);

  const runtimeAssets = ['desktop/main.mjs', 'desktop/runtime.mjs', 'server.mjs', 'index.html'];
  assert.deepEqual(new Set(manifest.build.files), new Set(['desktop/**/*', 'server.mjs', 'index.html']));
  for (const file of runtimeAssets) {
    assert.ok((await stat(new URL(file, manifestUrl))).isFile(), file);
  }
  assert.ok(manifest.dependencies.ws, 'electron-builder only bundles production dependencies');
});

function fetchDesktop(url, headers) {
  // Tests restart the same origin, so each probe should open a fresh connection.
  return fetch(url, { headers: { ...headers, Connection: 'close' } });
}

function fakeElectron({ loadPage, deferWindowClose = false } = {}) {
  const windows = [];
  const partitions = [];
  const session = {
    webRequest: {
      onBeforeSendHeaders(listener) { this.listener = listener; },
    },
    setPermissionCheckHandler(handler) { this.checkPermission = handler; },
    setPermissionRequestHandler(handler) { this.requestPermission = handler; },
  };

  function requestHeaders(url, requestHeaders = {}) {
    let result;
    session.webRequest.listener({ url, requestHeaders }, (response) => {
      result = response.requestHeaders ?? requestHeaders;
    });
    assert.ok(result, 'the hook must complete the Electron request');
    return result;
  }

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => { this.openWindow = handler; };
      this.webContents.getURL = () => this.url;
      windows.push(this);
    }

    async loadURL(url) {
      this.url = url;
      assert.equal(typeof session.checkPermission, 'function');
      assert.equal(typeof session.requestPermission, 'function');
      assert.equal(typeof this.openWindow, 'function');
      const page = await fetchDesktop(url, requestHeaders(url));
      assert.equal(page.status, 200, 'the protected loopback page must be ready during loadURL');
      const body = await page.text();
      assert.equal(body.includes(requestHeaders(url)[DESKTOP_CAPABILITY_HEADER]), false);
      await loadPage?.();
    }

    isDestroyed() { return this.destroyed === true; }
    close() {
      this.closeCalled = true;
      this.emit('close-requested');
      if (!deferWindowClose) this.finishClose();
    }
    destroy() {
      this.destroyCalled = true;
      this.finishClose();
    }
    finishClose() {
      if (this.isDestroyed()) return;
      this.destroyed = true;
      this.emit('closed');
    }

    show() { this.shown = true; }
    isMinimized() { return this.minimized === true; }
    restore() { this.minimized = false; }
    focus() { this.focused = true; }
  }

  return {
    session, windows, partitions, requestHeaders,
    dependencies: {
      BrowserWindow,
      getSession(partition) {
        partitions.push(partition);
        return session;
      },
    },
  };
}

async function claimDesktopPort() {
  const listener = createServer();
  listener.listen(4174, '127.0.0.1');
  await once(listener, 'listening');
  return () => new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  });
}

test('desktop starts the protected fixed origin before loading a hardened window', { timeout: 5_000 }, async (t) => {
  const electron = fakeElectron();
  const runtime = createDesktopRuntime(electron.dependencies);
  t.after(() => runtime.stop());

  const launch = await Promise.all([runtime.start(), runtime.start()]);
  assert.deepEqual(launch, [{ origin }, { origin }]);
  assert.deepEqual(electron.partitions, ['persist:meeting-minutes']);
  assert.equal(electron.windows.length, 1);
  const [window] = electron.windows;
  assert.equal(window.url, origin);
  assert.equal(window.shown, true);
  const { session, ...preferences } = window.options.webPreferences;
  assert.equal(session, electron.session);
  for (const [key, value] of Object.entries({
    sandbox: true,
    contextIsolation: true,
    webSecurity: true,
    nodeIntegration: false,
    webviewTag: false,
    allowRunningInsecureContent: false,
    devTools: false,
  })) {
    assert.equal(preferences[key], value, key);
  }
  assert.equal('preload' in preferences, false);

  window.minimized = true;
  runtime.focusMainWindow();
  assert.equal(window.minimized, false);
  assert.equal(window.focused, true);
});

test('the private session authorizes HTTP and WebSocket at the exact desktop origin and rotates the token', { timeout: 5_000 }, async (t) => {
  const electron = fakeElectron();
  const runtime = createDesktopRuntime(electron.dependencies);
  t.after(() => runtime.stop());
  await runtime.start();

  const statusUrl = origin + '/api/status';
  const denied = await fetchDesktop(statusUrl);
  assert.equal(denied.status, 403);
  await denied.text();
  const headers = electron.requestHeaders(statusUrl, { Accept: 'application/json', 'X-Meeting-Desktop-Token': 'untrusted' });
  const token = headers[DESKTOP_CAPABILITY_HEADER];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal('X-Meeting-Desktop-Token' in headers, false);
  assert.equal(headers.Accept, 'application/json');
  const authorized = await fetchDesktop(statusUrl, headers);
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.has(DESKTOP_CAPABILITY_HEADER), false);
  assert.equal((await authorized.text()).includes(token), false);

  for (const url of [
    'http://127.0.0.1:4173/api/status',
    'http://127.0.0.1:41740/api/status',
    'http://localhost:4174/api/status',
    'https://127.0.0.1:4174/api/status',
    'wss://127.0.0.1:4174/api/asr-stream',
    'blob:http://127.0.0.1:4174/id',
    'http://127.0.0.1:4174@example.test/api/status',
    'https://example.test/',
  ]) {
    assert.deepEqual(electron.requestHeaders(url, { Accept: '*/*', [DESKTOP_CAPABILITY_HEADER]: token }), { Accept: '*/*' }, url);
  }

  const wsHeaders = electron.requestHeaders(wsUrl, { origin });
  assert.equal(wsHeaders[DESKTOP_CAPABILITY_HEADER], token);
  const socket = new WebSocket(wsUrl, { headers: wsHeaders });
  t.after(() => socket.terminate());
  const socketClosed = once(socket, 'close');
  await once(socket, 'open');

  await Promise.all([runtime.stop(), runtime.stop(), socketClosed]);
  assert.equal(electron.windows[0].isDestroyed(), true);
  assert.equal(electron.session.webRequest.listener, null);
  const release = await claimDesktopPort();
  await release();

  const restarted = createDesktopRuntime(electron.dependencies);
  t.after(() => restarted.stop());
  assert.deepEqual(await restarted.start(), { origin });
  assert.notEqual(electron.requestHeaders(statusUrl)[DESKTOP_CAPABILITY_HEADER], token);
  const oldTokenResponse = await fetchDesktop(statusUrl, headers);
  assert.equal(oldTokenResponse.status, 403);
  await oldTokenResponse.text();
});

test('navigation and redirects stay on the desktop origin and all new windows are denied', { timeout: 5_000 }, async (t) => {
  const electron = fakeElectron();
  const runtime = createDesktopRuntime(electron.dependencies);
  t.after(() => runtime.stop());
  await runtime.start();
  const [window] = electron.windows;

  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    for (const [url, denied] of [
      [origin + '/next', false],
      ['http://127.0.0.1:4173/', true],
      ['http://localhost:4174/', true],
      ['https://127.0.0.1:4174/', true],
      ['blob:' + origin + '/id', true],
      ['file:///C:/Windows/', true],
      ['https://example.test/', true],
      ['malformed', true],
    ]) {
      let prevented = false;
      window.webContents.emit(name, { url, preventDefault() { prevented = true; } });
      assert.equal(prevented, denied, name + ' ' + url);
    }
  }
  assert.deepEqual(window.openWindow({ url: origin }), { action: 'deny' });
  assert.deepEqual(window.openWindow({ url: 'https://example.test/' }), { action: 'deny' });
});

test('only the current desktop main frame can receive microphone permission', { timeout: 5_000 }, async (t) => {
  const electron = fakeElectron();
  const runtime = createDesktopRuntime(electron.dependencies);
  t.after(() => runtime.stop());
  await runtime.start();
  const [window] = electron.windows;
  const contents = window.webContents;
  const { checkPermission, requestPermission } = electron.session;
  const details = { isMainFrame: true, requestingUrl: origin + '/minutes', securityOrigin: origin + '/' };
  const checkDetails = { ...details, mediaType: 'audio' };
  const requestDetails = { ...details, mediaTypes: ['audio'] };

  function request(webContents, permission, requestInfo) {
    const decisions = [];
    requestPermission(webContents, permission, (value) => decisions.push(value), requestInfo);
    assert.equal(decisions.length, 1);
    return decisions[0];
  }

  assert.equal(checkPermission(contents, 'media', origin + '/', checkDetails), true);
  assert.equal(request(contents, 'media', requestDetails), true);
  for (const [webContents, permission, changes] of [
    [null, 'media', {}],
    [{ getURL: () => origin }, 'media', {}],
    [contents, 'notifications', {}],
    [contents, 'display-capture', {}],
    [contents, 'media', { isMainFrame: false }],
    [contents, 'media', { isMainFrame: undefined }],
    [contents, 'media', { requestingUrl: undefined }],
    [contents, 'media', { requestingUrl: 'http://localhost:4174/' }],
    [contents, 'media', { requestingUrl: 'http://127.0.0.1:4173/' }],
    [contents, 'media', { requestingUrl: 'blob:' + origin + '/id' }],
    [contents, 'media', { securityOrigin: 'https://example.test/' }],
  ]) {
    assert.equal(checkPermission(webContents, permission, origin, { ...checkDetails, ...changes }), false);
    assert.equal(request(webContents, permission, { ...requestDetails, ...changes }), false);
  }
  assert.equal(checkPermission(contents, 'media', 'https://example.test', checkDetails), false);
  for (const mediaType of ['video', 'unknown', undefined]) {
    assert.equal(checkPermission(contents, 'media', origin, { ...checkDetails, mediaType }), false);
  }
  for (const mediaTypes of [['video'], ['audio', 'video'], ['audio', 'audio'], [], 'audio', undefined]) {
    assert.equal(request(contents, 'media', { ...requestDetails, mediaTypes }), false);
  }

  window.url = 'https://example.test/';
  assert.equal(checkPermission(contents, 'media', origin, checkDetails), false);
  assert.equal(request(contents, 'media', requestDetails), false);
  window.url = origin;
  window.destroy();
  assert.equal(checkPermission(contents, 'media', origin, checkDetails), false);
  assert.equal(request(contents, 'media', requestDetails), false);
});

test('a desktop port collision creates no BrowserWindow or desktop session', { timeout: 5_000 }, async (t) => {
  t.after(await claimDesktopPort());
  const electron = fakeElectron();
  const runtime = createDesktopRuntime(electron.dependencies);
  t.after(() => runtime.stop());

  await assert.rejects(runtime.start(), { code: 'EADDRINUSE' });
  assert.deepEqual(electron.windows, []);
  assert.deepEqual(electron.partitions, []);
});

test('a failed page load destroys the window and releases the listener', { timeout: 5_000 }, async (t) => {
  const electron = fakeElectron({ loadPage() { throw new Error('test page load failure'); } });
  const runtime = createDesktopRuntime(electron.dependencies);
  t.after(() => runtime.stop());

  await assert.rejects(runtime.start(), { message: 'test page load failure' });
  assert.equal(electron.windows[0].destroyCalled, true);
  assert.equal(electron.session.webRequest.listener, null);
  const release = await claimDesktopPort();
  await release();
});

test('shutdown waits for the graceful window close before stopping the server', { timeout: 5_000 }, async (t) => {
  const electron = fakeElectron({ deferWindowClose: true });
  const runtime = createDesktopRuntime(electron.dependencies);
  t.after(() => runtime.stop());
  await runtime.start();
  const [window] = electron.windows;
  const closeRequested = once(window, 'close-requested');
  const stopped = runtime.stop();

  try {
    await Promise.race([closeRequested, stopped]);
    assert.equal(window.closeCalled, true, 'shutdown should let the loaded page run its lifecycle handlers');
    assert.notEqual(window.destroyCalled, true);
    assert.equal(window.isDestroyed(), false);
    const statusUrl = origin + '/api/status';
    const response = await fetchDesktop(statusUrl, electron.requestHeaders(statusUrl));
    assert.equal(response.status, 200, 'the desktop session and server must still work while the window closes');
    await response.text();
  } finally {
    window.finishClose();
    await stopped;
  }

  assert.equal(electron.session.webRequest.listener, null);
  const release = await claimDesktopPort();
  await release();
});
