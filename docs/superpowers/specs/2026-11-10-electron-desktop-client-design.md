# Electron 桌面会议纪要客户端设计

## 意图

把现有单页会议纪要工具交付为可启动、可打包的 Windows 桌面客户端，同时保留阿里云百炼 Paraformer/SenseVoice 转写与千问纪要能力。用户继续在应用内输入百炼 Base URL、API Key 和模型；历史会议、逐字稿和草稿只保存在本机 Electron 配置档中。

## 目标

- 使用 Electron 主进程启动现有 Node 本机服务，并在窗口加载前确认它已监听成功。
- 让桌面应用在重启后继续使用同一 `http://127.0.0.1:4174` 源，因此本机 `localStorage` 中的历史会议与草稿不会因端口变化丢失。
- 保护渲染进程：启用沙箱、上下文隔离和 Web 安全；禁用 Node 集成、`webview`、新窗口和不受信任的导航。
- 将 API Key 继续只保存在本机服务进程内存中；不写入 Electron 用户目录、`localStorage`、预加载桥接或日志。
- 为桌面会话生成一次性能力令牌；令牌只由 Electron 主进程通过内部请求头注入，回环服务拒绝缺少或不匹配令牌的桌面请求。
- 仅允许受信任主窗口的同源音频媒体权限，拒绝摄像头和全部其他站点/框架的权限请求。
- 提供 `npm run desktop`、目录打包和 Windows NSIS 安装包命令，以及可复现的测试与使用说明。

## 非目标

- 不迁移用户先前在 Chrome、Edge 或旧浏览器演示页中保存的历史与草稿；浏览器配置档与 Electron 配置档天然隔离。
- 不把 API Key 持久化、同步到云端或交给渲染进程读取。
- 不在本轮改造转写协议、千问提示词、历史数据结构或页面交互设计。
- 不实现自动更新、代码签名、账号系统或跨设备同步。

## 方案比较

1. **Electron + 现有回环服务（采用）**：可直接复用已测试的静态页面、HTTP 纪要代理、WebSocket 实时转写和本机历史；主进程可严格配置窗口与权限。代价是安装包较大、固定端口被占用时必须明确报错。
2. **Tauri / Rust 壳**：产物更小，但需要重写本机 HTTP/WebSocket 生命周期和桌面桥接，当前功能迁移风险高；不采用。
3. **仅把页面包装为 PWA/快捷方式**：无法获得可控的应用生命周期、独立持久化配置档和窗口安全策略；不采用。

## 架构

```text
Electron main process
  ├─ 单实例锁、应用生命周期、启动错误对话框
  ├─ 固定回环服务 127.0.0.1:4174
  │    ├─ index.html
  │    ├─ /api/config、/api/minutes
  │    └─ /api/asr-stream
  └─ persist:meeting-minutes Electron session
       ├─ 对 127.0.0.1:4174 的 HTTP / WS 请求注入一次性令牌
       ├─ 仅授权主窗口的同源 audio 媒体权限
       └─ BrowserWindow 加载上述固定源

Renderer (无 Node / 无 preload bridge)
  └─ 现有 fetch、WebSocket、localStorage、Markdown 下载逻辑
```

### 回环服务与令牌

- 服务保留浏览器演示模式：没有传入 `desktopToken` 时，现有 `node server.mjs` 行为不变。
- 桌面运行时传入随机 256-bit URL-safe 令牌。页面、状态接口、配置接口、纪要接口和实时转写握手都需要匹配令牌；会修改配置或访问转写的请求还必须保持当前精确回环 Origin。
- 令牌仅存活于主进程和服务闭包；不会出现在 URL、HTML、API 响应、`window` 对象或 IPC 中。
- 服务启动失败（特别是 `EADDRINUSE`）时，不会改用随机端口或连接未知监听器，因为那会破坏历史持久化边界或把 API Key 发给其他进程。

### 窗口与权限

- `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`、`webviewTag: false`、`allowRunningInsecureContent: false`。
- 没有预加载脚本，因此页面没有文件系统、Shell 或 Electron API。
- 同源导航之外的导航、重定向及 `window.open` 一律阻止。
- `session.setPermissionCheckHandler` 和 `setPermissionRequestHandler` 同时约束：仅当前主窗口、精确桌面源和仅音频媒体可被允许。

### 数据与退出

- 历史、逐字稿、草稿仍由页面的 `localStorage` 管理，存储于命名持久化 Electron 会话，只有本机用户可见。
- API Key 只存于服务的内存连接对象，退出应用后自动消失。
- 关闭应用时终止本地转写 WebSocket，并关闭 HTTP 服务，从而释放固定端口。

## 验收

- 运行时先监听回环服务、再加载窗口；端口占用时不创建窗口且报出可诊断错误。
- 同一桌面源在两次启动之间保持一致；服务关闭后端口可重新监听。
- 令牌缺失或错误时，桌面保护的 HTTP 和 WebSocket 请求返回拒绝；正确令牌不会被任何响应回显。
- 窗口配置不开放 Node、`webview`、外部导航、新窗口或非音频权限；只允许受信任窗口的麦克风请求。
- `npm test` 全绿，`npm run desktop:pack` 生成可运行的 Windows 未封装目录；`npm run desktop:dist` 可生成 NSIS 安装器。
- 当前工程以非强制方式推送到用户指定的 GitHub 仓库，不覆盖既有远端历史。
