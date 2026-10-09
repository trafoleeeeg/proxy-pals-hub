const electron = require("electron");
require("./runtime/native-crash-capture.cjs").startNativeCrashCapture(
  electron, process.env.UMBRA_PRIVATE_BROWSER_CHILD === "1" ? "browser" : "coordinator",
);
if (require("./runtime/browser-pipe.cjs").superviseBrowser()) return;
const { app, BrowserWindow, ipcMain, session, shell, dialog, safeStorage, Notification, powerMonitor } = electron;
const { initializeBackgroundWorkers, allowBackgroundWorkers } = require("./runtime/background-workers.cjs");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const {
  launchProfileWindow, closeProfileWindow, snapshotProfileCookies, acknowledgeProfileCookies, reconcileProfileCookieSave, listCookieRecoveryBackups,
  listRunningProfiles, closeAllProfiles, refreshExtensions, extensionStore,
  applyBrowserSettings, applyBookmarkDefaults,
} = require("./launcher.cjs");
const { checkProxy } = require("./proxy-check.cjs");
const { isTrustedSender, isWebUrl } = require("./ipc-policy.cjs");
const { createUpdateController } = require("./update-controller.cjs");
const { createSessionOutbox } = require("./session-outbox.cjs");
const { checkEngineVersions } = require("./runtime/engine-status.cjs");
const { recordProcessEvent } = require("./runtime/process-diagnostics.cjs");
const { createPanelStartup, panelBackground } = require("./runtime/panel-startup.cjs");
const { createPanelBundle } = require("./runtime/panel-bundle.cjs");

const DEFAULT_APP_URL = "https://proxy-pals-hub.lovable.app/app";
// A packaged client must never let a local environment variable replace the
// trusted panel origin. This origin controls which page receives the IPC
// bridge and therefore must be fixed in the release binary.
const APP_URL = app.isPackaged ? DEFAULT_APP_URL : (process.env.UMBRA_APP_URL || DEFAULT_APP_URL);
if (!isWebUrl(APP_URL)) throw new Error("Invalid application URL");
const APP_ORIGIN = new URL(APP_URL).origin;
if (app.isPackaged && new URL(APP_URL).protocol !== "https:") throw new Error("The installed application requires HTTPS");
app.enableSandbox();
app.commandLine.appendSwitch("disable-quic");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.setAppUserModelId("dev.umbra.desktop");

let mainWindow = null;
let panelStartup = null;
let panelBundle = null;
let updates = null;
let updateTimer = null;
let outbox = null;
let quitting = false;
let closing = false;
let proxyChecks = 0;
let extensionDownloads = 0;
function diagnose(event, details) {
  try { recordProcessEvent(app.getPath("userData"), event, details); } catch { /* Never disrupt the browser for diagnostics. */ }
}
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function profileClosed(payload) {
  const entry = outbox.enqueue(payload);
  send("umbra:profile-closed", entry);
}

function createWindow(prepare = Promise.resolve()) {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 620,
    backgroundColor: panelBackground, autoHideMenuBar: true, title: "Umbra", show: false,
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
  const startup = createPanelStartup(electron, window, {
    appUrl: APP_URL, version: app.getVersion(), prepare,
    localPanel: () => !!panelBundle,
    isClosing: () => quitting || closing,
    showError: async () => {
      const result = await dialog.showMessageBox(window, {
        type: "error", title: "Umbra", message: "Не удалось загрузить панель",
        detail: "Проверьте подключение к интернету. Локальные данные профилей сохранены.",
        buttons: ["Повторить", "Закрыть"], defaultId: 0, cancelId: 1,
      });
      return result.response === 0;
    },
  });
  panelStartup = startup;

  window.on("close", (event) => {
    if (!quitting && listRunningProfiles().length) { event.preventDefault(); app.quit(); }
  });
  window.on("closed", () => { if (mainWindow === window) { mainWindow = null; panelStartup = null; } });
  void startup.start().catch((error) => {
    if (window.isDestroyed() || quitting || closing) return;
    dialog.showErrorBox("Umbra", String(error.message || error));
    app.quit();
  });
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event, mainWindow, APP_ORIGIN)) throw new Error("Untrusted IPC sender");
    try { return await handler(...args); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The skeleton never receives a preload or privileged bridge. Only the trusted
// panel's top frame can reveal its own already-painted interface.
handle("umbra:panel-ready", () => { panelStartup?.ready(); return { ok: true }; });
function profileId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid profile ID");
  return value;
}
handle("umbra:launch-profile", async (payload) => {
  if (closing || quitting || updates?.isInstalling()) throw new Error("Приложение закрывается или устанавливает обновление");
  profileId(payload?.profileId);
  if (JSON.stringify(payload).length > 6 * 1024 * 1024) throw new Error("Данные профиля слишком большие");
  try {
    const profile = await launchProfileWindow(payload, profileClosed);
    return { ok: true, ...(profile.recoveryBackupId ? { recoveryBackupId: profile.recoveryBackupId } : {}) };
  } catch (error) {
    if (error.code === "COOKIE_RECOVERY_CONFLICT") return { ok: false, error: error.message, code: error.code, recovery: error.recovery };
    throw error;
  }
});
handle("umbra:cookie-recovery-backups", async id => ({ ok: true, backups: await listCookieRecoveryBackups(profileId(id)) }));
handle("umbra:close-profile", async (id) => {
  const snapshot = await closeProfileWindow(profileId(id));
  return { ok: true, ...snapshot };
});
handle("umbra:profile-cookies", async (id, cookieSaveProtocol) => {
  const snapshot = await snapshotProfileCookies(profileId(id), cookieSaveProtocol);
  return { ok: true, cookies: null, ...snapshot };
});
handle("umbra:acknowledge-profile-cookies", async (payload) => {
  profileId(payload?.profileId);
  return { ok: true, applied: await acknowledgeProfileCookies(payload) };
});
handle("umbra:reconcile-profile-cookie-save", async payload => ({ ok: true, applied: await reconcileProfileCookieSave(payload) }));
handle("umbra:list-running-profiles", () => ({ ok: true, profiles: listRunningProfiles() }));
handle("umbra:browser-settings-push", async (settings) => ({ ok: true, applied: await applyBrowserSettings(settings) }));
handle("umbra:bookmark-defaults-push", async (settings) => ({ ok: true, applied: await applyBookmarkDefaults(settings) }));
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
handle("umbra:runtime-capabilities", () => ({
  fontIsolation: process.platform === "win32" && typeof session.defaultSession.setUmbraFontIsolation === "function",
}));
handle("umbra:check-engine-versions", async () => ({ ok: true, ...(await checkEngineVersions()) }));
handle("umbra:update-state", () => updates?.getState() || { state: "none" });
handle("umbra:check-update", () => updates.check());
handle("umbra:download-update", () => updates.download());
handle("umbra:install-update", () => updates.install());
handle("umbra:extensions-list", async () => ({ ok: true, extensions: await extensionStore.list() }));
// Clipboard reads only happen on the trusted panel's explicit paste action.
handle("umbra:proxy-clipboard", () => require("electron").clipboard.readText().slice(0, 1_048_576));
handle("umbra:extensions-add", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите распакованное расширение",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "Добавление расширения отменено" };
  const extension = await extensionStore.addFromDirectory(result.filePaths[0]);
  const failures = await refreshExtensions();
  return { ok: true, extension, failures };
});
handle("umbra:extensions-add-url", async (url) => {
  if (typeof url !== "string" || url.length > 2048) throw new Error("Ссылка указана неверно");
  const consent = await dialog.showMessageBox(mainWindow, {
    type: "warning", title: "Загрузка расширения", message: "Скачать расширение на этот компьютер?",
    detail: "Загрузка выполняется приложением вне прокси профиля. Сервер загрузки увидит адрес вашей сети. Расширение не включается в профилях автоматически; разрешайте только доверенный код.",
    buttons: ["Отмена", "Скачать"], defaultId: 0, cancelId: 0,
  });
  if (consent.response !== 1) return { ok: false, error: "Загрузка отменена" };
  if (extensionDownloads >= 2) throw new Error("Дождитесь окончания текущей загрузки расширения");
  extensionDownloads++;
  try {
    const extension = await extensionStore.addFromUrl(url);
    const failures = await refreshExtensions();
    return { ok: true, extension, failures };
  } finally { extensionDownloads--; }
});
handle("umbra:extensions-update", async (id) => {
  if (typeof id !== "string") throw new Error("Некорректный идентификатор расширения");
  const consent = await dialog.showMessageBox(mainWindow, {
    type: "warning", title: "Обновление расширения", message: "Скачать обновление расширения?",
    detail: "Запрос выполняется вне прокси профиля. Сервер загрузки увидит адрес вашей сети. Обновление меняет код расширения во всех профилях, где вы его разрешили.",
    buttons: ["Отмена", "Обновить"], defaultId: 0, cancelId: 0,
  });
  if (consent.response !== 1) return { ok: false, error: "Обновление отменено" };
  if (extensionDownloads >= 2) throw new Error("Дождитесь окончания текущей загрузки расширения");
  extensionDownloads++;
  try {
    const extension = await extensionStore.update(id);
    const failures = await refreshExtensions();
    return { ok: true, extension, failures };
  } finally { extensionDownloads--; }
});
handle("umbra:extensions-remove", async (id) => {
  await extensionStore.remove(id);
  await refreshExtensions();
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  diagnose("browser-start");
  process.on("disconnect", () => diagnose("coordinator-disconnect"));
  process.on("uncaughtExceptionMonitor", () => diagnose("browser-uncaught-exception"));
  app.on("render-process-gone", (_event, contents, details) => {
    if (contents === mainWindow?.webContents) diagnose("renderer-gone", { role: "panel", reason: details?.reason, exitCode: details?.exitCode, contentsId: contents.id });
  });
  app.on("child-process-gone", (_event, details) => diagnose("child-process-gone", {
    reason: details?.reason, exitCode: details?.exitCode, processType: details?.type,
  }));
  app.on("will-quit", () => diagnose("browser-will-quit"));
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    outbox = createSessionOutbox(path.join(app.getPath("userData"), "session-outbox"), safeStorage);
    const preparePanel = (async () => {
      // Show the harmless local shell now, but do not load any remote renderer
      // before its worker policy and permission handlers have been installed.
      await initializeBackgroundWorkers();
      const panelSession = session.fromPartition("persist:umbra-app");
      panelSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      panelSession.setPermissionCheckHandler(() => false);
      await allowBackgroundWorkers(panelSession);
      if (app.isPackaged) {
        try {
          panelBundle = createPanelBundle({ panelSession, origin: APP_ORIGIN, desktopVersion: app.getVersion(),
            bundledDirectory: path.join(__dirname, "panel"),
            cacheDirectory: path.join(app.getPath("userData"), "panel-bundles"), safeStorage });
          // Downloads never block first paint or hot-swap a working session.
          const timer = setTimeout(() => { void panelBundle.update(); }, 15_000);
          timer.unref();
        } catch { diagnose("panel-bundle-fallback"); }
      }
    })();
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
    createWindow(preparePanel);
    // Wake the control panel only. Do not reload/close working profile tabs or
    // replay profile/proxy mutations when the laptop resumes.
    powerMonitor.on("resume", () => send("umbra:panel-resume"));
    app.on("umbra:profile-protection-failed", ({ saved }) => {
      const body = saved
        ? "Защита фонового процесса потеряна. Профиль остановлен, локальные данные сохранены. Откройте профиль снова."
        : "Защита фонового процесса потеряна. Сеть профиля заблокирована, но сохранение не завершено. Повторите закрытие профиля; не завершайте Umbra принудительно.";
      if (Notification.isSupported()) {
        const notice = new Notification({ title: "Umbra — защитная остановка профиля", body });
        notice.on("click", () => mainWindow?.focus());
        notice.show();
      } else {
        void dialog.showMessageBox({ type: "warning", title: "Umbra", message: body }).catch(() => {});
      }
    });
    app.on("umbra:profile-restart-required", () => {
      const body = "Профиль закрыт и данные сохранены, но остановка фоновых процессов не подтвердилась. Перезапустите Umbra перед повторным открытием профиля.";
      if (Notification.isSupported()) {
        const notice = new Notification({ title: "Umbra — требуется перезапуск", body });
        notice.on("click", () => mainWindow?.focus());
        notice.show();
      } else {
        void dialog.showMessageBox({ type: "warning", title: "Umbra", message: body }).catch(() => {});
      }
    });
    app.on("umbra:browser-settings-changed", (settings) => send("umbra:browser-settings-changed", settings));
    app.on("umbra:manage-extensions", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      void mainWindow.loadURL(`${APP_ORIGIN}/app/desktop`).catch(() => {});
    });
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
  if (!closing) diagnose("browser-before-quit");
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
