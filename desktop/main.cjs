const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const http = require("node:http");
const { autoUpdater } = require("electron-updater");
const { launchProfileWindow, closeProfileWindow } = require("./launcher.cjs");

const APP_URL = process.env.UMBRA_APP_URL || "https://proxy-pals-hub.lovable.app/app";
const BASE_URL = APP_URL.replace(/\/app.*$/, "");
const PROTOCOL = "umbra";

let mainWindow = null;
let pendingTokens = null;
let callbackPort = null;

/* ---------- локальный приёмник токенов из системного браузера ---------- */

function startCallbackServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (url.pathname !== "/cb") {
        res.writeHead(404).end();
        return;
      }
      const access_token = url.searchParams.get("access_token");
      const refresh_token = url.searchParams.get("refresh_token");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (access_token && refresh_token) {
        deliverTokens({ access_token, refresh_token });
        res.end(
          "<meta charset='utf-8'><body style='font:16px sans-serif;background:#111312;color:#e8ece9;display:flex;align-items:center;justify-content:center;height:100vh'>Вход выполнен — вернитесь в приложение Umbra. Эту вкладку можно закрыть.</body>",
        );
      } else {
        res.end("<meta charset='utf-8'>Не удалось передать вход в приложение.");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      callbackPort = server.address().port;
      resolve(callbackPort);
    });
    server.on("error", () => resolve(null));
  });
}

function deliverTokens(tokens) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("umbra:auth-tokens", tokens);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingTokens = tokens;
  }
}

/* ---------- единственный экземпляр + deep link umbra:// ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    handleDeepLink(argv.find((a) => a.startsWith(`${PROTOCOL}://`)));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function handleDeepLink(url) {
  if (!url) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const params = new URLSearchParams((parsed.hash || "").replace(/^#/, "") || parsed.search);
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return;
  deliverTokens({ access_token, refresh_token });
}

/* ---------- основное окно ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#111312",
    autoHideMenuBar: true,
    title: "Umbra",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:umbra-app",
    },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingTokens) {
      mainWindow.webContents.send("umbra:auth-tokens", pendingTokens);
      pendingTokens = null;
    }
  });

  // Любые внешние ссылки (включая вход через Google) открываем в системном браузере,
  // где пользователь уже авторизован.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  registerProtocol();
  handleDeepLink(process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)));
  session.fromPartition("persist:umbra-app");
  await startCallbackServer();
  createWindow();

  autoUpdater.autoDownload = false;
  autoUpdater.on("update-available", (info) => send("umbra:update", { state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => send("umbra:update", { state: "none" }));
  autoUpdater.on("download-progress", (p) => send("umbra:update", { state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => send("umbra:update", { state: "downloaded", version: info.version }));
  autoUpdater.on("error", (err) => send("umbra:update", { state: "error", error: String(err && err.message ? err.message : err) }));

  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------- IPC ---------- */

ipcMain.handle("umbra:launch-profile", async (_e, payload) => {
  try {
    await launchProfileWindow(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("umbra:close-profile", async (_e, profileId) => {
  closeProfileWindow(profileId);
  return { ok: true };
});

ipcMain.handle("umbra:open-auth", async () => {
  if (!callbackPort) await startCallbackServer();
  const cb = callbackPort ? `http://127.0.0.1:${callbackPort}/cb` : null;
  const url =
    `${BASE_URL}/auth?desktop=1` + (cb ? `&cb=${encodeURIComponent(cb)}` : "");
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("umbra:open-external", async (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("umbra:check-update", async () => {
  if (!app.isPackaged) return { ok: false, error: "Обновления доступны только в установленном приложении" };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r && r.updateInfo ? r.updateInfo.version : null, current: app.getVersion() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("umbra:download-update", async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("umbra:install-update", async () => {
  // isSilent=true, isForceRunAfter=true — данные профилей в userData сохраняются.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
});

ipcMain.handle("umbra:app-version", async () => app.getVersion());
