const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const {
  launchProfileWindow,
  closeProfileWindow,
  snapshotProfileCookies,
} = require("./launcher.cjs");
const { checkProxy } = require("./proxy-check.cjs");

const APP_URL = process.env.UMBRA_APP_URL || "https://proxy-pals-hub.lovable.app/app";

let mainWindow = null;

/* ---------- единственный экземпляр ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ---------- основное окно ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#111217",
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

  // Внешние ссылки открываем в системном браузере.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ---------- автообновление ---------- */

// Последнее состояние обновления: панель запрашивает его сразу после загрузки,
// чтобы уведомление не потерялось, если событие пришло раньше отрисовки.
let updateState = { state: "none" };

function setUpdateState(next) {
  updateState = next;
  send("umbra:update", next);
}

app.whenReady().then(async () => {
  session.fromPartition("persist:umbra-app");
  createWindow();

  // Новая версия скачивается сразу — пользователю остаётся один клик.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => setUpdateState({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setUpdateState({ state: "downloading", percent: 0, version: info.version }),
  );
  autoUpdater.on("update-not-available", () => setUpdateState({ state: "none" }));
  autoUpdater.on("download-progress", (p) =>
    setUpdateState({
      state: "downloading",
      percent: Math.round(p.percent),
      version: updateState.version,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    setUpdateState({ state: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (err) =>
    setUpdateState({ state: "error", error: String(err && err.message ? err.message : err) }),
  );

  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
    // Частая проверка: новая версия появляется в приложении почти сразу после релиза.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 15 * 60 * 1000);
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
    await launchProfileWindow(payload, (result) => send("umbra:profile-closed", result));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("umbra:close-profile", async (_e, profileId) => {
  closeProfileWindow(profileId);
  return { ok: true };
});

ipcMain.handle("umbra:profile-cookies", async (_e, profileId) => {
  const cookies = await snapshotProfileCookies(profileId);
  return { ok: true, cookies };
});

ipcMain.handle("umbra:check-proxy", async (_e, payload) => {
  try {
    return { ok: true, result: await checkProxy(payload || {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("umbra:open-external", async (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("umbra:update-state", async () => updateState);

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
