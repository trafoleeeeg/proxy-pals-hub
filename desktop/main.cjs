const { app, BrowserWindow, ipcMain, session, shell, dialog, safeStorage, Notification } = require("electron");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const {
  launchProfileWindow, closeProfileWindow, snapshotProfileCookies,
  listRunningProfiles, closeAllProfiles,
} = require("./launcher.cjs");
const { checkProxy } = require("./proxy-check.cjs");
const { isTrustedSender, isWebUrl } = require("./ipc-policy.cjs");
const { createUpdateController } = require("./update-controller.cjs");
const { createSessionOutbox } = require("./session-outbox.cjs");

const APP_URL = process.env.UMBRA_APP_URL || "https://proxy-pals-hub.lovable.app/app";
if (!isWebUrl(APP_URL)) throw new Error("Invalid application URL");
const APP_ORIGIN = new URL(APP_URL).origin;
if (app.isPackaged && new URL(APP_URL).protocol !== "https:") throw new Error("The installed application requires HTTPS");
app.enableSandbox();
app.commandLine.appendSwitch("disable-quic");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.setAppUserModelId("dev.umbra.desktop");

let mainWindow = null;
let updates = null;
let updateTimer = null;
let outbox = null;
let quitting = false;
let closing = false;
let proxyChecks = 0;
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function profileClosed(payload) {
  const entry = outbox.enqueue(payload);
  send("umbra:profile-closed", entry);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 620,
    backgroundColor: "#111217", autoHideMenuBar: true, title: "Umbra",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      partition: "persist:umbra-app",
      additionalArguments: [
        "--umbra-version=" + app.getVersion(),
        "--umbra-app-origin=" + encodeURIComponent(APP_ORIGIN),
      ],
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isWebUrl(url) || new URL(url).origin !== APP_ORIGIN) {
      event.preventDefault();
      if (isWebUrl(url)) void shell.openExternal(url).catch(() => {});
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isWebUrl(url) || new URL(url).origin !== APP_ORIGIN) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const loadPanel = async () => {
    try { await window.loadURL(APP_URL); }
    catch {
      if (window.isDestroyed() || quitting) return;
      const result = await dialog.showMessageBox(window, {
        type: "error", title: "Umbra", message: "Не удалось загрузить панель",
        detail: "Проверьте подключение к интернету. Локальные данные профилей сохранены.",
        buttons: ["Повторить", "Закрыть"], defaultId: 0, cancelId: 1,
      });
      if (result.response === 0) void loadPanel();
      else window.close();
    }
  };
  window.on("close", (event) => {
    if (!quitting && listRunningProfiles().length) { event.preventDefault(); app.quit(); }
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  void loadPanel();
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event, mainWindow, APP_ORIGIN)) throw new Error("Untrusted IPC sender");
    try { return await handler(...args); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function profileId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid profile ID");
  return value;
}
handle("umbra:launch-profile", async (payload) => {
  if (closing || quitting || updates?.isInstalling()) throw new Error("Приложение закрывается или устанавливает обновление");
  profileId(payload?.profileId);
  if (JSON.stringify(payload).length > 6 * 1024 * 1024) throw new Error("Profile payload is too large");
  await launchProfileWindow(payload, profileClosed);
  return { ok: true };
});
handle("umbra:close-profile", async (id) => {
  const snapshot = await closeProfileWindow(profileId(id));
  return { ok: true, ...snapshot };
});
handle("umbra:profile-cookies", async (id) => {
  const snapshot = await snapshotProfileCookies(profileId(id));
  return { ok: true, cookies: null, ...snapshot };
});
handle("umbra:list-running-profiles", () => ({ ok: true, profiles: listRunningProfiles() }));
handle("umbra:pending-profile-closures", () => ({ ok: true, profiles: outbox.list() }));
handle("umbra:acknowledge-profile-closure", (id) => { outbox.acknowledge(id); return { ok: true }; });
handle("umbra:archive-profile-closure", (id) => { outbox.archive(id); return { ok: true }; });
handle("umbra:check-proxy", async (payload) => {
  if (proxyChecks >= 4) throw new Error("Дождитесь завершения текущих проверок прокси");
  proxyChecks++;
  try { return { ok: true, result: await checkProxy(payload || {}) }; }
  finally { proxyChecks--; }
});
handle("umbra:open-external", async (url) => {
  if (!isWebUrl(url)) throw new Error("Разрешены только ссылки HTTP и HTTPS");
  await shell.openExternal(url);
  return { ok: true };
});
handle("umbra:app-version", () => app.getVersion());
handle("umbra:update-state", () => updates?.getState() || { state: "none" });
handle("umbra:check-update", () => updates.check());
handle("umbra:download-update", () => updates.download());
handle("umbra:install-update", () => updates.install());

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    outbox = createSessionOutbox(path.join(app.getPath("userData"), "session-outbox"), safeStorage);
    const panelSession = session.fromPartition("persist:umbra-app");
    panelSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    panelSession.setPermissionCheckHandler(() => false);
    updates = createUpdateController({
      updater: autoUpdater,
      enabled: app.isPackaged && process.platform === "win32" && !process.env.PORTABLE_EXECUTABLE_FILE,
      currentVersion: app.getVersion(),
      hasOpenProfiles: () => listRunningProfiles().length > 0 || closing,
      onState: (state) => {
        send("umbra:update", state);
        if (state.state === "downloaded" && Notification.isSupported()) {
          const notice = new Notification({ title: "Umbra", body: "Обновление " + state.version + " готово к установке" });
          notice.on("click", () => mainWindow?.focus());
          notice.show();
        }
      },
    });
    createWindow();
    if (app.isPackaged) {
      void updates.check();
      updateTimer = setInterval(() => void updates.check(), 15 * 60 * 1000);
      updateTimer.unref();
    }
    app.on("activate", () => { if (!mainWindow) createWindow(); });
  }).catch((error) => { dialog.showErrorBox("Umbra", String(error.message || error)); app.quit(); });
}
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  Promise.resolve().then(() => closeAllProfiles()).then(() => {
    quitting = true;
    clearInterval(updateTimer);
    app.quit();
  }).catch((error) => {
    closing = false;
    dialog.showErrorBox("Не удалось сохранить профиль", String(error.message || error));
  });
});
app.on("window-all-closed", () => { if (!closing) app.quit(); });
