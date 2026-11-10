import { app, BrowserWindow, dialog, session } from 'electron';
import { createDesktopRuntime } from './runtime.mjs';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const runtime = createDesktopRuntime({
    BrowserWindow,
    getSession: (partition) => session.fromPartition(partition),
  });
  let launched = false;
  let stopping;
  let canQuit = false;

  app.on('second-instance', () => runtime.focusMainWindow());
  app.on('window-all-closed', () => {
    if (launched && !stopping) app.quit();
  });
  app.on('before-quit', (event) => {
    if (canQuit) return;
    event.preventDefault();
    stopping ??= runtime.stop().catch(() => {
      process.exitCode = 1;
    }).finally(() => {
      canQuit = true;
      app.quit();
    });
  });

  app.whenReady().then(async () => {
    if (stopping) return;
    await runtime.start();
    launched = true;
  }).catch((error) => {
    if (stopping) return;
    const message = error.code === 'EADDRINUSE'
      ? '本机端口 4174 已被占用。请关闭占用此端口的程序后重试。'
      : '无法启动会议纪要桌面客户端。请退出后重试。';
    dialog.showErrorBox('会议纪要启动失败', message);
    app.quit();
  });
}
