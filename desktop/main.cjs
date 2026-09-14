const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const { launchProfileWindow, closeProfileWindow } = require("./launcher.cjs");

const APP_URL = process.env.UMBRA_APP_URL || "https://proxy-pals-hub.lovable.app/app";

let mainWindow = null;

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

  // Внешние ссылки открываем в системном браузере, окна OAuth — внутри приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/accounts\.google\.com|supabase\.co|lovable\.(dev|app)/.test(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: { partition: "persist:umbra-app", contextIsolation: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Разрешаем сторонние cookies внутри партиции приложения, иначе вход через Google срывается.
  session.fromPartition("persist:umbra-app");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

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
