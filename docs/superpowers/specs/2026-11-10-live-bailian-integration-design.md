# 百炼实时转写与千问纪要设计

## 意图

将现有的单页会议纪要演示升级为可由用户在本机填写百炼 Host、API Key 与模型后使用的真实服务链路。未配置时，原有离线演示和历史纪要功能保持可用；已配置时，浏览器麦克风音频经本机服务转发至 Paraformer，逐字稿再由同一服务转发给 Qwen 生成结构化纪要。

## 目标

- 浏览器不直接获得或请求百炼 API Key；Key 仅存在于本机 Node 进程内存。
- 使用 Paraformer v2 的实时 WebSocket 协议获取中文会议的实时逐字稿。
- 使用用户配置的 Qwen OpenAI-compatible Base URL 调用 `/chat/completions`，返回并验证固定的会议纪要结构。
- 保留无配置时的本地演示录音和本地规则纪要；真实服务发生错误时明确告知，不静默回退为演示结果。
- 继续仅监听 `127.0.0.1`，并保留 Host、Origin、CSP、响应脱敏和无持久化 Key 的边界。

## 非目标

- 不持久化 Key 到浏览器存储、文件或操作系统凭据库。
- 不实现 Paraformer 录音文件转写/OSS 上传。该 HTTP API 只接受百炼可访问的公开 URL；本次采用实时 WebSocket，避免把本机音频上传到第三方存储。
- 不实现说话人分离、云端历史同步、账号系统或 SenseVoice。SenseVoice 已处于下线迁移阶段，新实现选择 Paraformer v2。

## 已采用的方案

### 1. 本机 Qwen 代理

`POST /api/minutes` 仅接收 `{ topic, transcript }`。本机服务从进程内配置读取 `host`、`apiKey` 与 `model`，向 `${host}/chat/completions` 发起非流式请求。请求使用固定系统指令、`response_format: { type: 'json_object' }` 和 `max_completion_tokens`，而非让浏览器传入任意 messages、headers 或模型请求选项。

`qwen-plus` 和 `qwen-max` 均可继续被选用；因此使用兼容范围更广的 JSON Object 模式，而不强制仅部分新模型支持的 `json_schema`。服务端会解析并验证 `overview`、`conclusions`、`actions` 和 `questions`，拒绝截断、空内容、无效 JSON 或不符合结构的远端输出。

### 2. Paraformer v2 实时代理

浏览器连接到同源 `ws://127.0.0.1:<port>/api/asr-stream`。它以 Web Audio API 采集单声道音频，降采样为 16 kHz PCM16，再把二进制帧发送给本机服务。本机服务以 Key 作为 Authorization header 连接由 Base URL 推导出的 `wss://<workspace-host>/api-ws/v1/inference`，发送 Paraformer 的 `run-task`，等待 `task-started` 后转发 PCM 帧；结束时发送 `finish-task`，仅把脱敏后的结果文本、时戳和错误消息发回浏览器。

音频数据不会写入磁盘、历史记录或日志。由于 Paraformer 实时服务使用北京地域，本 Demo 的 Base URL 必须是无账号信息、无查询参数、默认 HTTPS 端口、路径恰为 `/compatible-mode/v1` 的北京百炼地址：`dashscope.aliyuncs.com` 或 `*.cn-beijing.maas.aliyuncs.com`。真实远程调用禁止 HTTP 与重定向。用户选择 Host 即是在本机明确授权将 Key 发送给该百炼服务；任意自定义/内网 Host 会在保存配置时拒绝，避免把 Key 当作开放代理凭据。

### 3. 页面状态

- 未配置：按钮仍为“开始演示录音”，继续追加预置片段，纪要使用本地规则生成。
- 已配置：按钮改为“开始真实录音”，请求麦克风权限并显示连接、转写、收尾和错误状态。远程异常不会制造演示文本。
- 已配置且逐字稿非空：生成纪要按钮调用 `/api/minutes`；成功结果进入既有纪要渲染、历史和 Markdown 导出路径。

## 服务接口

| 接口 | 输入 | 输出 | 安全规则 |
| --- | --- | --- | --- |
| `GET /api/status` | 无 | `configured`、`host`、`model`、`asrEndpoint` | 永不返回 Key |
| `POST /api/config` | `host`、`apiKey`、`model` | 上述公开状态 | 精确 loopback Host/Origin、JSON、内存保存 |
| `POST /api/minutes` | `topic`、`transcript` | 验证后的 minutes 对象 | 精确 loopback Host/Origin、长度限制、固定上游请求 |
| `WS /api/asr-stream` | `start` / PCM16 二进制 / `finish` | `ready` / `result` / `finished` / `error` | 精确 loopback Host/Origin、单连接任务、绝不回传 Key |

Minutes 的稳定结构：

```json
{
  "overview": "string",
  "conclusions": ["string"],
  "actions": [{ "task": "string", "owner": "string", "due": "string" }],
  "questions": ["string"]
}
```

## 外部协议依据

- [Paraformer 实时 WebSocket 连接与鉴权](https://help.aliyun.com/en/model-studio/websocket-for-paraformer-real-time-service)
- [Paraformer 客户端事件](https://help.aliyun.com/en/model-studio/paraformer-client-events)
- [Paraformer 服务端结果事件](https://help.aliyun.com/en/model-studio/paraformer-server-events)
- [Qwen OpenAI-compatible Chat Completions](https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope)

## 验收与测试

- 单元/服务测试验证上游 Qwen 请求路径、授权头、固定指令、分钟结构校验和安全错误映射，且响应不含 Key。
- WebSocket 测试验证未配置拒绝、`run-task` 的格式、结果转发、非法 Origin/Host 拒绝以及 Key 不进入浏览器事件。
- 浏览器测试验证配置后的 Generate 调用本机 minutes 路由、未配置时仍是演示模式，以及真实模式状态不会静默伪造逐字稿。
- 全量 `node --test tests/*.test.mjs` 必须通过。
