const { contextBridge, ipcRenderer } = require("electron");
const { version } = require("./package.json");

contextBridge.exposeInMainWorld("umbra", {
  isDesktop: true,
  version,
  platform: process.platform,
  launchProfile: (payload) => ipcRenderer.invoke("umbra:launch-profile", payload),
  closeProfile: (profileId) => ipcRenderer.invoke("umbra:close-profile", profileId),
  profileCookies: (profileId) => ipcRenderer.invoke("umbra:profile-cookies", profileId),
  onProfileClosed: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("umbra:profile-closed", handler);
    return () => ipcRenderer.removeListener("umbra:profile-closed", handler);
  },
  openExternal: (url) => ipcRenderer.invoke("umbra:open-external", url),

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
