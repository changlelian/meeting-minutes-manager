import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createMeetingServer, normalizeConnectionHost } from '../server.mjs';
import * as meetingServer from '../server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexPath = join(root, 'index.html');
const MODEL_STUDIO_BASE_URL = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

async function startServer(options = {}) {
  const server = createMeetingServer({ indexPath, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { server, baseUrl: 'http://127.0.0.1:' + address.port };
}

async function saveConnection(baseUrl, { host = MODEL_STUDIO_BASE_URL, apiKey = 'demo-secret-not-real', model = 'qwen-plus' } = {}) {
  return fetch(baseUrl + '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ host, apiKey, model }),
  });
}

async function stopServer(server) {
  server.close();
  await once(server, 'close');
}

async function startMockWebSocketServer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  return { server, url: 'ws://127.0.0.1:' + address.port };
}

async function stopMockWebSocketServer(server) {
  server.close();
  await once(server, 'close');
}

async function waitFor(condition, message) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function rawGet(baseUrl, path, headers) {
  const target = new URL(baseUrl + path);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end();
  });
}

const desktopToken = 'desktop-test-token';
const desktopHeader = 'x-meeting-desktop-token';

test('desktop token gates page, status, configuration and minutes requests', async () => {
  const minutesResult = { overview: '已验证桌面权限。', conclusions: [], actions: [], questions: [] };
  const upstreamHeaders = [];
  const { server, baseUrl } = await startServer({
    desktopToken,
    fetchImpl: async (_url, options) => {
      upstreamHeaders.push(new Headers(options.headers));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(minutesResult) } }] });
    },
  });
  const headers = { 'content-type': 'application/json', origin: baseUrl };
  const config = {
    method: 'POST', headers,
    body: JSON.stringify({ host: MODEL_STUDIO_BASE_URL, apiKey: 'desktop-api-key-not-real' }),
  };
  const minutes = {
    method: 'POST', headers,
    body: JSON.stringify({ transcript: '验证桌面权限。' }),
  };
  try {
    for (const token of [undefined, 'wrong-token']) {
      for (const [path, options] of [['/', {}], ['/index.html', {}], ['/api/status', {}], ['/api/config', config], ['/api/minutes', minutes]]) {
        const response = await fetch(baseUrl + path, {
          ...options, headers: { ...options.headers, ...(token && { [desktopHeader]: token }) },
        });
        assert.equal(response.status, 403, `${path} must reject a ${token ? 'wrong' : 'missing'} token`);
        assert.equal(response.headers.has(desktopHeader), false);
        assert.doesNotMatch(await response.text(), /desktop-test-token/);
      }
    }

    const authorized = { [desktopHeader]: desktopToken };
    const page = await fetch(baseUrl + '/', { headers: authorized });
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /desktop-test-token/);
    const status = await fetch(baseUrl + '/api/status', { headers: authorized });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { configured: false, host: '', model: 'qwen-plus', asrEndpoint: '' });
    const rebinding = await rawGet(baseUrl, '/', { ...authorized, host: 'example.test' });
    assert.equal(rebinding.statusCode, 421);

    for (const [path, options] of [['/api/config', config], ['/api/minutes', minutes]]) {
      const rejectedOrigin = await fetch(baseUrl + path, {
        ...options, headers: { ...headers, ...authorized, origin: 'http://localhost:' + server.address().port },
      });
      assert.equal(rejectedOrigin.status, 403);
      assert.doesNotMatch(await rejectedOrigin.text(), /desktop-test-token/);
    }
    const saved = await fetch(baseUrl + '/api/config', { ...config, headers: { ...headers, ...authorized } });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.has(desktopHeader), false);
    assert.doesNotMatch(await saved.text(), /desktop-test-token|desktop-api-key-not-real/);
    const generated = await fetch(baseUrl + '/api/minutes', { ...minutes, headers: { ...headers, ...authorized } });
    assert.equal(generated.status, 200);
    assert.deepEqual(await generated.json(), { minutes: minutesResult });
    assert.equal(upstreamHeaders.length, 1);
    assert.equal(upstreamHeaders[0].has(desktopHeader), false);
    assert.equal(meetingServer.DESKTOP_CAPABILITY_HEADER, desktopHeader);
  } finally {
    await stopServer(server);
  }
});

function observeAsrUpgrade(baseUrl, headers) {
  const client = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/asr-stream', { headers });
  return new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('open', () => {
      client.close();
      client.once('close', () => resolve({ status: 101 }));
    });
    client.once('unexpected-response', async (_request, response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        reject(error);
      } finally {
        client.terminate();
      }
    });
  });
}

test('desktop token gates ASR upgrades while keeping exact Origin validation', async () => {
  const { server, baseUrl } = await startServer({ desktopToken });
  try {
    for (const headers of [
      { origin: baseUrl },
      { origin: baseUrl, [desktopHeader]: 'wrong-token' },
      { origin: 'http://localhost:' + server.address().port, [desktopHeader]: desktopToken },
    ]) {
      const response = await observeAsrUpgrade(baseUrl, headers);
      assert.equal(response.status, 403);
      assert.doesNotMatch(response.body, /desktop-test-token/);
    }
    assert.equal((await observeAsrUpgrade(baseUrl, { origin: baseUrl, [desktopHeader]: desktopToken })).status, 101);
  } finally {
    await stopServer(server);
  }
});

test('token-less browser demo still serves pages and accepts same-origin ASR upgrades', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const page = await fetch(baseUrl + '/');
    assert.equal(page.status, 200);
    await page.text();
    assert.equal((await observeAsrUpgrade(baseUrl, { origin: baseUrl })).status, 101);
  } finally {
    await stopServer(server);
  }
});

test('managed loopback binds the requested origin and releases it on stop', { timeout: 5_000 }, async () => {
  const existing = await startServer();
  const options = { host: '127.0.0.1', port: existing.server.address().port, indexPath };
  try {
    assert.equal(typeof meetingServer.startMeetingServer, 'function');
    await assert.rejects(meetingServer.startMeetingServer(options), { code: 'EADDRINUSE' });
  } finally {
    await stopServer(existing.server);
  }

  const managed = await meetingServer.startMeetingServer(options);
  try {
    assert.equal(managed.origin, existing.baseUrl);
    const page = await fetch(managed.origin + '/');
    assert.equal(page.status, 200);
    await page.text();
  } finally {
    await Promise.all([managed.stop(), managed.stop()]);
  }

  const restarted = await meetingServer.startMeetingServer(options);
  try {
    assert.equal(restarted.origin, managed.origin);
  } finally {
    await restarted.stop();
  }
});

test('managed loopback terminates connected ASR clients on stop', { timeout: 5_000 }, async () => {
  assert.equal(typeof meetingServer.startMeetingServer, 'function');
  const managed = await meetingServer.startMeetingServer({ host: '127.0.0.1', port: 0, indexPath, desktopToken });
  const client = new WebSocket(managed.origin.replace('http:', 'ws:') + '/api/asr-stream', {
    headers: { origin: managed.origin, [desktopHeader]: desktopToken },
  });
  const closed = once(client, 'close');
  let timeout;
  try {
    await once(client, 'open');
    const deadline = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('ASR client did not close during managed stop')), 1_500);
    });
    await Promise.race([Promise.all([managed.stop(), closed]), deadline]);
  } finally {
    clearTimeout(timeout);
    client.terminate();
    await managed.stop();
  }
});

test('managed loopback stop waits for the active ASR relay to close', { timeout: 5_000 }, async () => {
  const { server: mockAsr, url: mockAsrUrl } = await startMockWebSocketServer();
  mockAsr.on('connection', (socket) => {
    socket.once('message', (data) => {
      const { header } = JSON.parse(data.toString());
      socket.send(JSON.stringify({ header: { event: 'task-started', task_id: header.task_id } }));
    });
  });

  let upstream;
  const managed = await meetingServer.startMeetingServer({
    port: 0, indexPath, desktopToken,
    createAsrSocket: () => (upstream = new WebSocket(mockAsrUrl)),
  });
  let localTransportClosed = false;
  managed.server.once('upgrade', (_request, socket) => {
    socket.once('close', () => { localTransportClosed = true; });
  });
  const headers = { origin: managed.origin, [desktopHeader]: desktopToken };
  let client;
  try {
    const saved = await fetch(managed.origin + '/api/config', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ host: MODEL_STUDIO_BASE_URL, apiKey: 'desktop-api-key-not-real' }),
    });
    assert.equal(saved.status, 200);
    await saved.text();

    client = new WebSocket(managed.origin.replace('http:', 'ws:') + '/api/asr-stream', { headers });
    await once(client, 'open');
    const ready = once(client, 'message');
    client.send(JSON.stringify({ action: 'start' }));
    const [message] = await ready;
    assert.deepEqual(JSON.parse(message.toString()), { type: 'ready' });
    assert.equal(upstream.readyState, WebSocket.OPEN);

    const peerClosed = once(client, 'close');
    await managed.stop();
    assert.equal(upstream.readyState, WebSocket.CLOSED, 'stop must wait for the outbound ASR socket to close');
    assert.equal(localTransportClosed, true, 'stop must wait for the server-side local ASR socket to close');
    await peerClosed;
  } finally {
    client?.terminate();
    upstream?.terminate();
    await managed.stop();
    await stopMockWebSocketServer(mockAsr);
  }
});

test('normalizeConnectionHost accepts only official Model Studio HTTPS base URLs', () => {
  assert.equal(normalizeConnectionHost(` ${MODEL_STUDIO_BASE_URL}/ `), MODEL_STUDIO_BASE_URL);
  assert.equal(normalizeConnectionHost('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(normalizeConnectionHost('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), null);
  assert.equal(normalizeConnectionHost('https://model.example.test/compatible-mode/v1'), null);
  assert.equal(normalizeConnectionHost('https://workspace.cn-beijing.maas.aliyuncs.com/other'), null);
  assert.equal(normalizeConnectionHost('http://127.0.0.1:9000/v1'), null);
  assert.equal(normalizeConnectionHost('ftp://example.test'), null);
  assert.equal(normalizeConnectionHost('https://key@example.test/v1'), null);
  assert.equal(normalizeConnectionHost('not a url'), null);
});

test('loopback configuration status never returns the submitted API key', async () => {
  const { server, baseUrl } = await startServer();
  const secret = 'demo-secret-not-real';
  try {
    const save = await saveConnection(baseUrl, { apiKey: secret });
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.deepEqual(saved, {
      configured: true,
      host: MODEL_STUDIO_BASE_URL,
      model: 'qwen-plus',
      asrEndpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
    });
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));

    const status = await fetch(baseUrl + '/api/status');
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.deepEqual(body, saved);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
  } finally {
    await stopServer(server);
  }
});

test('loopback configuration rejects invalid hosts without changing status', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const rejected = await fetch(baseUrl + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ host: 'https://model.example.test/compatible-mode/v1', apiKey: 'demo-secret-not-real', model: 'qwen-plus' }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /百炼|Base URL/);

    const status = await fetch(baseUrl + '/api/status');
    assert.deepEqual(await status.json(), { configured: false, host: '', model: 'qwen-plus', asrEndpoint: '' });
  } finally {
    await stopServer(server);
  }
});

test('loopback configuration rejects non-JSON requests before reading a secret', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const rejected = await fetch(baseUrl + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: baseUrl },
      body: JSON.stringify({ host: MODEL_STUDIO_BASE_URL, apiKey: 'demo-secret-not-real', model: 'qwen-plus' }),
    });
    assert.equal(rejected.status, 415);
    assert.match((await rejected.json()).message, /application\/json/);

    const status = await fetch(baseUrl + '/api/status');
    assert.deepEqual(await status.json(), { configured: false, host: '', model: 'qwen-plus', asrEndpoint: '' });
  } finally {
    await stopServer(server);
  }
});

test('loopback configuration rejects cross-origin and rebinding-host requests', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const rejectedOrigin = await fetch(baseUrl + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example.test' },
      body: JSON.stringify({ host: MODEL_STUDIO_BASE_URL, apiKey: 'demo-secret-not-real', model: 'qwen-plus' }),
    });
    assert.equal(rejectedOrigin.status, 403);

    const rejectedHost = await rawGet(baseUrl, '/', { host: 'attacker.example.test' });
    assert.equal(rejectedHost.statusCode, 421);

    const status = await fetch(baseUrl + '/api/status');
    assert.deepEqual(await status.json(), { configured: false, host: '', model: 'qwen-plus', asrEndpoint: '' });
  } finally {
    await stopServer(server);
  }
});

test('loopback server serves the demo document from the root route', async () => {
  assert.equal(existsSync(indexPath), true);
  const { server, baseUrl } = await startServer();
  try {
    const page = await fetch(baseUrl + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /会记/);
  } finally {
    await stopServer(server);
  }
});

test('minutes proxy sends a fixed Qwen request and returns only validated minutes', async () => {
  const secret = 'qwen-secret-never-returned';
  const minutes = {
    overview: '团队确认在周三完成方案评审。',
    conclusions: ['先完成设计评审。'],
    actions: [{ task: '输出设计稿', owner: '王敏', due: '周三' }],
    questions: ['是否需要额外的可用性测试？'],
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(minutes) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, baseUrl } = await startServer({ fetchImpl });
  try {
    assert.equal((await saveConnection(baseUrl, { apiKey: secret })).status, 200);
    const response = await fetch(baseUrl + '/api/minutes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ topic: '产品评审', transcript: '王敏：周三前输出设计稿。' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { minutes });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, MODEL_STUDIO_BASE_URL + '/chat/completions');
    assert.equal(calls[0].options.headers.authorization, 'Bearer ' + secret);
    assert.equal(calls[0].options.redirect, 'error');
    const requestBody = JSON.parse(calls[0].options.body);
    assert.equal(requestBody.model, 'qwen-plus');
    assert.equal(requestBody.stream, false);
    assert.equal(requestBody.response_format.type, 'json_object');
    assert.match(requestBody.messages[0].content, /JSON/);
    assert.deepEqual(requestBody.messages[1], { role: 'user', content: '会议主题：产品评审\n\n逐字稿：\n王敏：周三前输出设计稿。' });
  } finally {
    await stopServer(server);
  }
});

test('minutes proxy refuses caller input and malformed model output without exposing a key', async () => {
  const secret = 'qwen-secret-never-returned';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"overview":"only-one-field"}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, baseUrl } = await startServer({ fetchImpl });
  try {
    assert.equal((await saveConnection(baseUrl, { apiKey: secret })).status, 200);
    const empty = await fetch(baseUrl + '/api/minutes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ topic: '产品评审', transcript: '' }),
    });
    assert.equal(empty.status, 400);
    assert.equal(calls, 0);

    const malformed = await fetch(baseUrl + '/api/minutes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ topic: '产品评审', transcript: '请总结当前会议。' }),
    });
    assert.equal(malformed.status, 502);
    const body = await malformed.json();
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
    assert.match(body.message, /纪要|上游/);
  } finally {
    await stopServer(server);
  }
});

test('configuration requires a bounded string API key and a JSON object payload', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const nullPayload = await fetch(baseUrl + '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: 'null',
    });
    assert.equal(nullPayload.status, 400);
    const numericKey = await fetch(baseUrl + '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify({ host: MODEL_STUDIO_BASE_URL, apiKey: 42, model: 'qwen-plus' }),
    });
    assert.equal(numericKey.status, 400);
    assert.deepEqual(await (await fetch(baseUrl + '/api/status')).json(), { configured: false, host: '', model: 'qwen-plus', asrEndpoint: '' });
  } finally {
    await stopServer(server);
  }
});

test('minutes proxy aborts a body that stalls after upstream response headers', async () => {
  const secret = 'timeout-secret-never-returned';
  const encoder = new TextEncoder();
  let abortObserved = false;
  const delayedMinutes = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ overview: '延迟结果', conclusions: [], actions: [], questions: [] }) } }] });
  const fetchImpl = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => { abortObserved = true; controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      setTimeout(() => { if (!abortObserved) { controller.enqueue(encoder.encode(delayedMinutes)); controller.close(); } }, 60);
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const { server, baseUrl } = await startServer({ fetchImpl, qwenTimeoutMs: 15 });
  try {
    assert.equal((await saveConnection(baseUrl, { apiKey: secret })).status, 200);
    const response = await fetch(baseUrl + '/api/minutes', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify({ topic: '超时测试', transcript: '等待模型结果。' }),
    });
    assert.equal(response.status, 504);
    assert.equal(abortObserved, true);
    assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(secret));
  } finally {
    await stopServer(server);
  }
});

test('Paraformer relay sends an authenticated run-task and returns final transcript text', async () => {
  const secret = 'asr-secret-never-returned';
  const { server: mockAsr, url: mockAsrUrl } = await startMockWebSocketServer();
  const upstreamMessages = [];
  const upstreamBinaryFrames = [];
  let observedEndpoint = '';
  let observedAuthorization = '';
  mockAsr.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        upstreamBinaryFrames.push(Buffer.from(data));
        const taskId = upstreamMessages.find((event) => event.header?.action === 'run-task').header.task_id;
        socket.send(JSON.stringify({
          header: { event: 'result-generated', task_id: taskId, attributes: {} },
          payload: { output: { sentence: { begin_time: 0, end_time: 900, text: '请确认周三前输出设计稿。', heartbeat: false, sentence_end: true } }, usage: { duration: 1 } },
        }));
        return;
      }
      const event = JSON.parse(data.toString('utf8'));
      upstreamMessages.push(event);
      if (event.header?.action === 'run-task') {
        socket.send(JSON.stringify({ header: { event: 'task-started', task_id: event.header.task_id, attributes: {} }, payload: {} }));
      }
      if (event.header?.action === 'finish-task') {
        socket.send(JSON.stringify({ header: { event: 'task-finished', task_id: event.header.task_id, attributes: {} }, payload: { output: {}, usage: null } }));
      }
    });
  });

  const { server, baseUrl } = await startServer({
    createAsrSocket(endpoint, options) {
      observedEndpoint = endpoint;
      observedAuthorization = options.headers.Authorization;
      return new WebSocket(mockAsrUrl);
    },
  });
  let client;
  try {
    assert.equal((await saveConnection(baseUrl, { apiKey: secret })).status, 200);
    client = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/asr-stream', { headers: { origin: baseUrl } });
    const clientEvents = [];
    client.on('message', (data) => clientEvents.push(JSON.parse(data.toString('utf8'))));
    await once(client, 'open');
    client.send(JSON.stringify({ action: 'start' }));

    await waitFor(() => clientEvents.some((event) => event.type === 'ready'), 'expected local ASR ready event');
    assert.equal(observedEndpoint, 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference');
    assert.equal(observedAuthorization, 'Bearer ' + secret);
    assert.doesNotMatch(JSON.stringify(clientEvents), new RegExp(secret));
    const runTask = upstreamMessages.find((event) => event.header?.action === 'run-task');
    assert.deepEqual(runTask.payload, {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: 'paraformer-realtime-v2',
      input: {},
      parameters: {
        format: 'pcm',
        sample_rate: 16000,
        language_hints: ['zh', 'en'],
        semantic_punctuation_enabled: true,
      },
    });

    client.send(Buffer.from([1, 2, 3, 4]));
    await waitFor(() => upstreamBinaryFrames.length === 1, 'expected PCM frame at Paraformer relay');
    await waitFor(() => clientEvents.some((event) => event.type === 'result'), 'expected transcript event at local client');
    assert.deepEqual(clientEvents.find((event) => event.type === 'result'), {
      type: 'result', text: '请确认周三前输出设计稿。', final: true, beginTime: 0, endTime: 900,
    });

    const closed = once(client, 'close');
    client.send(JSON.stringify({ action: 'finish' }));
    await waitFor(() => upstreamMessages.some((event) => event.header?.action === 'finish-task'), 'expected Paraformer finish-task event');
    await waitFor(() => clientEvents.some((event) => event.type === 'finished'), 'expected local ASR finished event');
    await closed;
    client = null;
  } finally {
    client?.close();
    await stopServer(server);
    await stopMockWebSocketServer(mockAsr);
  }
});

test('Paraformer relay rejects cross-origin starts before opening an upstream socket', async () => {
  let upstreamCalls = 0;
  const { server, baseUrl } = await startServer({
    createAsrSocket() {
      upstreamCalls += 1;
      throw new Error('must not connect');
    },
  });
  try {
    assert.equal((await saveConnection(baseUrl)).status, 200);
    const statusCode = await new Promise((resolve, reject) => {
      const client = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/asr-stream', { headers: { origin: 'https://attacker.example.test' } });
      client.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      client.once('error', reject);
    });
    assert.equal(statusCode, 403);
    assert.equal(upstreamCalls, 0);
  } finally {
    await stopServer(server);
  }
});

test('Paraformer relay cancels an upstream socket when the local client disconnects during connect', async () => {
  let upstreamTerminated = 0;
  const pendingUpstream = new EventEmitter();
  pendingUpstream.readyState = WebSocket.CONNECTING;
  pendingUpstream.terminate = () => { upstreamTerminated += 1; pendingUpstream.readyState = WebSocket.CLOSED; pendingUpstream.emit('close'); };
  const { server, baseUrl } = await startServer({ createAsrSocket: () => pendingUpstream });
  let client;
  try {
    assert.equal((await saveConnection(baseUrl)).status, 200);
    client = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/asr-stream', { headers: { origin: baseUrl } });
    await once(client, 'open');
    client.send(JSON.stringify({ action: 'start' }));
    await waitFor(() => pendingUpstream.listenerCount('open') === 1, 'expected pending upstream connection');
    client.terminate();
    await waitFor(() => upstreamTerminated === 1, 'expected connecting upstream to be terminated');
    client = null;
  } finally {
    client?.terminate();
    await stopServer(server);
  }
});

test('Paraformer relay reports a bounded error when task-started never arrives', async () => {
  const { server: mockAsr, url: mockAsrUrl } = await startMockWebSocketServer();
  const { server, baseUrl } = await startServer({
    asrStartTimeoutMs: 20,
    createAsrSocket: () => new WebSocket(mockAsrUrl),
  });
  let client;
  try {
    assert.equal((await saveConnection(baseUrl)).status, 200);
    client = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/asr-stream', { headers: { origin: baseUrl } });
    const events = [];
    client.on('message', (data) => events.push(JSON.parse(data.toString('utf8'))));
    await once(client, 'open');
    client.send(JSON.stringify({ action: 'start' }));
    await waitFor(() => events.some((event) => event.type === 'error'), 'expected ASR startup timeout error');
    assert.match(events.find((event) => event.type === 'error').message, /超时/);
    client.terminate();
    client = null;
  } finally {
    client?.terminate();
    await stopServer(server);
    await stopMockWebSocketServer(mockAsr);
  }
});
