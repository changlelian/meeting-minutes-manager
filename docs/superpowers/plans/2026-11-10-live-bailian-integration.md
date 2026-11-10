# 百炼实时转写与千问纪要 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本机会议纪要 Demo 在用户自行填写百炼连接信息后，能进行 Paraformer 实时转写与 Qwen 结构化纪要生成。

**Architecture:** Node 服务保持为唯一的 Key 持有者和百炼客户端。它新增固定形状的 HTTP minutes 代理以及同源 WebSocket ASR relay；浏览器只收发逐字稿、结构化纪要和无密钥音频帧。无配置路径保留为现有离线演示。

**Tech Stack:** Node.js ESM、原生 `http`/`fetch`、`ws`、浏览器 Web Audio API、现有 Node test runner。

**Spec:** `docs/superpowers/specs/2026-11-10-live-bailian-integration-design.md`

## Global Constraints

- API Key 只能存在于 Node 进程内存，绝不能写入页面状态、浏览器存储、URL、日志、响应或导出文件。
- 所有本机 HTTP/WS 请求必须保持精确的 `127.0.0.1:<port>` Host 和同源 Origin 校验。
- Qwen 请求只能由服务端构造固定 endpoint、header、系统提示与 JSON 输出要求；浏览器不能提供任意上游请求选项。
- 保存连接时只接受无凭据、默认 HTTPS 端口且路径为 `/compatible-mode/v1` 的北京地域 `dashscope.aliyuncs.com` 或 `*.cn-beijing.maas.aliyuncs.com` Base URL；Paraformer 实时链路需要该地域。
- Paraformer 使用 `paraformer-realtime-v2`、单声道 16 kHz PCM 和官方 `run-task` / `finish-task` 生命周期。
- 没有 Git 仓库；不创建提交。每项任务的验证命令与进度记录替代提交记录。

## Review Focus

- 错误或重定向上游响应不得把 API Key 或远端回显泄露给浏览器。
- 没有配置、无麦克风权限或 ASR 握手失败时不得落入演示数据而误导用户。
- Qwen 返回的代码块、截断 JSON、空字段或错误 action 类型必须被拒绝而非保存到历史。
- WebSocket 连接在完成、失败、页面关闭和新建会议时必须关闭本地音频资源和上游任务。
- 配置后的真实模式和未配置的演示模式必须维持各自正确的文案与现有历史/导出行为。

---

### Task 1: Qwen 分钟代理与验证器

**Files:**
- Modify: `server.mjs`
- Modify: `tests/local-server.test.mjs`

**Interfaces:**
- Produces `normalizeMinutes(value) -> Minutes | null`、`createQwenMinutes(config, payload, fetchImpl) -> Promise<Minutes>` 和 `POST /api/minutes`。
- Consumes现有内存 `connection` 与 `normalizeConnectionHost()`。

- [ ] **Step 1: 写入 `/api/minutes` 的失败测试**

覆盖已配置时的上游 URL/Authorization/固定 JSON body、成功的结构化返回、无效模型 JSON、空逐字稿、HTTP 上游错误及 Key 脱敏。

- [ ] **Step 2: 运行新服务测试以确认失败**

Run: `node --test tests/local-server.test.mjs`

Expected: FAIL，因为 `/api/minutes` 和 Qwen 验证器尚不存在。

- [ ] **Step 3: 在 `server.mjs` 实现固定 Qwen 请求和 minutes 验证**

`POST /api/minutes` 接收 `{ topic, transcript }`，对上游使用 `${host}/chat/completions`、`Authorization: Bearer <Key>`、`redirect: 'error'`、超时及安全错误映射；仅返回验证通过的 Minutes。

- [ ] **Step 4: 再次运行服务测试以确认通过**

Run: `node --test tests/local-server.test.mjs`

Expected: PASS。

### Task 2: Paraformer 本机 WebSocket relay

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Modify: `server.mjs`
- Modify: `tests/local-server.test.mjs`

**Interfaces:**
- Consumes Task 1 的进程内 `connection`。
- Produces同源 `WS /api/asr-stream`，事件为 `ready`、`result`、`finished`、`error`。

- [ ] **Step 1: 写入 relay 的失败测试**

测试未配置连接、loopback/Origin 拒绝、官方 `run-task` 载荷和 `result-generated` 到浏览器的脱敏映射。

- [ ] **Step 2: 运行该测试以确认失败**

Run: `node --test tests/local-server.test.mjs`

Expected: FAIL，因为 WebSocket upgrade/relay 尚不存在。

- [ ] **Step 3: 添加 `ws` 依赖并实现 relay**

使用 `WebSocketServer({ noServer: true })` 接受同源升级；由派生的 WSS endpoint 创建后端 socket，转发二进制 PCM 和官方事件。每条本地 socket 只允许一个任务，发生结束/错误时清理。

- [ ] **Step 4: 运行服务测试以确认通过**

Run: `node --test tests/local-server.test.mjs`

Expected: PASS。

### Task 3: 浏览器真实模式与安全回退

**Files:**
- Modify: `index.html`
- Modify: `tests/meeting-demo.browser.test.mjs`

**Interfaces:**
- Consumes Task 1 的 `POST /api/minutes` 和 Task 2 的 WebSocket 事件。
- Produces `startLiveRecording()`、`stopLiveRecording()`、`generateMinutes()` 的真实服务路径；不配置时继续调用现有 `startDemo()` / `createMinutes()`。

- [ ] **Step 1: 写入浏览器行为的失败测试**

覆盖已配置生成时请求相对 `/api/minutes`、未配置时维持本地生成、真实 ASR 模式的连接错误可见且不追加演示片段。

- [ ] **Step 2: 运行浏览器测试以确认失败**

Run: `node --test tests/meeting-demo.browser.test.mjs`

Expected: FAIL，因为页面尚未调 minutes 路由或建立 ASR WebSocket。

- [ ] **Step 3: 实现页面真实模式**

以 16 kHz PCM16 采集麦克风，发往相对同源 WebSocket；控制带使用现有技术极简状态样式。Qwen 成功后将结果复用到现有纪要、历史和导出路径，失败保留已有内容并给出操作性错误。

- [ ] **Step 4: 运行浏览器测试以确认通过**

Run: `node --test tests/meeting-demo.browser.test.mjs`

Expected: PASS。

### Task 4: 全量验证和现场启动

**Files:**
- Modify: `docs/superpowers/specs/2026-11-10-live-bailian-integration-design.md`（仅当实现决定需要记录时）

**Interfaces:**
- Consumes前三项的实现和测试。
- Produces可从 `node server.mjs --port 4173` 启动并让用户自行配置的本机运行版本。

- [ ] **Step 1: 执行完整测试套件**

Run: `node --test tests/*.test.mjs`

Expected: PASS，0 failures。

- [ ] **Step 2: 检查 loopback 页面与安全响应头**

Run: `node server.mjs --port 4173` 后执行 `Invoke-WebRequest http://127.0.0.1:4173/`

Expected: HTTP 200 且 CSP 与 `X-Frame-Options: DENY` 存在。

- [ ] **Step 3: 更新进度 ledger**

记录每项任务的测试证据、没有 Git 提交的原因，以及任何需交接的安全判断。

## 自检

- Specs 覆盖了实时 ASR、真实 Qwen、无配置回退、Key 隔离、Host/Origin 与验收测试；Task 1–3 分别实现并测试。
- 上游接口由 Task 1 先定义，Task 3 明确消费其固定相对路径；ASR relay 由 Task 2 定义，Task 3 消费其事件。
- 重点风险均对应了 Task 1–3 的测试，最终由 Task 4 跑全量套件。
