import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DESKTOP_CAPABILITY_HEADER, startMeetingServer } from '../server.mjs';

const DESKTOP_HOST = '127.0.0.1';
const DESKTOP_PORT = 4174;
const DESKTOP_PARTITION = 'persist:meeting-minutes';

function networkOrigin(url) {
  const parsed = URL.parse(url);
  return parsed && `${parsed.protocol}//${parsed.host}`;
}

export function createDesktopRuntime({ BrowserWindow, getSession }) {
  let serverReady;
  let startup;
  let stopping;
  let desktopSession;
  let mainWindow;
  let windowReady = false;

  function configureSession(origin, token) {
    const webSocketOrigin = origin.replace('http:', 'ws:');
    desktopSession.webRequest.onBeforeSendHeaders(({ url, requestHeaders }, callback) => {
      const headers = { ...requestHeaders };
      // Strip any existing variant, including headers carried across a redirect.
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === DESKTOP_CAPABILITY_HEADER) delete headers[name];
      }
      const target = networkOrigin(url);
      if (target === origin || target === webSocketOrigin) {
        headers[DESKTOP_CAPABILITY_HEADER] = token;
      }
      callback({ requestHeaders: headers });
    });

    function isMainFrameMedia(contents, permission, details) {
      return Boolean(mainWindow)
        && !stopping
        && contents === mainWindow.webContents
        && permission === 'media'
        && details?.isMainFrame === true
        && networkOrigin(contents.getURL()) === origin
        && networkOrigin(details.requestingUrl) === origin
        && (details.securityOrigin === undefined || networkOrigin(details.securityOrigin) === origin);
    }

    desktopSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      isMainFrameMedia(contents, permission, details)
      && networkOrigin(requestingOrigin) === origin
      && details.mediaType === 'audio');

    desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(isMainFrameMedia(contents, permission, details)
        && Array.isArray(details.mediaTypes)
        && details.mediaTypes.length === 1
        && details.mediaTypes[0] === 'audio');
    });
  }

  async function openWindow(token) {
    const { origin } = await serverReady;
    if (stopping) throw new Error('Desktop runtime is stopping.');

    desktopSession = getSession(DESKTOP_PARTITION);
    configureSession(origin, token);
    const window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        session: desktopSession,
        sandbox: true,
        contextIsolation: true,
        webSecurity: true,
        nodeIntegration: false,
        webviewTag: false,
        allowRunningInsecureContent: false,
        devTools: false,
      },
    });
    mainWindow = window;
    window.once('closed', () => { mainWindow = undefined; });

    function preventForeignNavigation(event) {
      if (networkOrigin(event.url) !== origin) event.preventDefault();
    }
    window.webContents.on('will-navigate', preventForeignNavigation);
    window.webContents.on('will-frame-navigate', preventForeignNavigation);
    window.webContents.on('will-redirect', preventForeignNavigation);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    await window.loadURL(origin);
    if (stopping || window.isDestroyed()) throw new Error('Desktop window closed during startup.');
    window.show();
    windowReady = true;
    return { origin };
  }

  async function closeResources() {
    const managedServer = await serverReady?.catch(() => {});
    try {
      if (mainWindow) {
        if (windowReady) {
          const closed = once(mainWindow, 'closed');
          mainWindow.close();
          await closed;
        } else {
          mainWindow.destroy();
        }
      }
    } finally {
      try {
        desktopSession?.webRequest.onBeforeSendHeaders(null);
      } finally {
        await managedServer?.stop();
      }
    }
  }

  function stop() {
    stopping ??= closeResources();
    return stopping;
  }

  return {
    start() {
      if (stopping) return Promise.reject(new Error('Desktop runtime is stopping.'));
      if (!startup) {
        const token = randomBytes(32).toString('base64url');
        serverReady = startMeetingServer({ host: DESKTOP_HOST, port: DESKTOP_PORT, desktopToken: token });
        startup = openWindow(token).catch(async (error) => {
          await stop();
          throw error;
        });
      }
      return startup;
    },
    stop,
    focusMainWindow() {
      if (!mainWindow || stopping) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    },
  };
}
