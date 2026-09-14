const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("umbra", {
  isDesktop: true,
  version: "0.2.0",
  platform: process.platform,
  launchProfile: (payload) => ipcRenderer.invoke("umbra:launch-profile", payload),
  closeProfile: (profileId) => ipcRenderer.invoke("umbra:close-profile", profileId),

  // Вход через системный браузер: там пользователь уже залогинен в Google.
  openAuth: () => ipcRenderer.invoke("umbra:open-auth"),
  openExternal: (url) => ipcRenderer.invoke("umbra:open-external", url),
  onAuthTokens: (cb) => {
    const handler = (_e, tokens) => cb(tokens);
    ipcRenderer.on("umbra:auth-tokens", handler);
    return () => ipcRenderer.removeListener("umbra:auth-tokens", handler);
  },

  // Обновление в один клик.
  appVersion: () => ipcRenderer.invoke("umbra:app-version"),
  checkUpdate: () => ipcRenderer.invoke("umbra:check-update"),
  downloadUpdate: () => ipcRenderer.invoke("umbra:download-update"),
  installUpdate: () => ipcRenderer.invoke("umbra:install-update"),
  onUpdateStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("umbra:update", handler);
    return () => ipcRenderer.removeListener("umbra:update", handler);
  },
});
