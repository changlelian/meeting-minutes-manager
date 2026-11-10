# 会议纪要桌面客户端

Windows 客户端支持录音、实时转写、生成会议纪要和导出 Markdown。

## 安装与启动

已有安装包时，运行 `MeetingMinutes-Setup-*.exe`，安装后从开始菜单打开 **Meeting Minutes**。从源码启动时，先安装 Node.js 24 和 npm，再在项目目录运行以下命令。

```powershell
npm ci
npm run desktop
```

## 连接百炼与录音

1. 点击应用右上角的齿轮，打开 **本机服务配置**。填写百炼控制台提供的 OpenAI-compatible Base URL 和 API Key，选择 Qwen 模型，再点击 **保存本次配置**。
2. 点击 **开始真实录音**。如果麦克风无法使用，打开 Windows **设置 → 隐私和安全性 → 麦克风**，开启麦克风访问和桌面应用的麦克风访问权限。
3. 使用百炼时，录音会发送到百炼进行转写，生成纪要时逐字稿会发送到所选 Qwen 模型。API Key 仅保存在本机服务的内存中，完全退出应用后需要重新填写。

已保存的会议历史、逐字稿和当前草稿保存在当前 Windows 用户的 Electron 配置档中，重启应用后仍可使用。Chrome、Edge 等浏览器演示页中的历史和草稿不会迁移到桌面客户端。

## 端口占用

桌面客户端固定使用 `127.0.0.1:4174`。如果启动时提示端口已被占用，请关闭占用该端口的程序，再打开客户端。

## 构建 Windows 版本

```powershell
npm run desktop:pack
npm run desktop:dist
```

x64 构建的 `desktop:pack` 产物是 `dist/win-unpacked/Meeting Minutes.exe`，可在该目录内直接运行。`desktop:dist` 生成 `dist/MeetingMinutes-Setup-<版本>-<架构>.exe` 安装包。
