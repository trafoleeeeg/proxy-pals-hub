const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("umbra", {
  isDesktop: true,
  version: "0.1.0",
  platform: process.platform,
  launchProfile: (payload) => ipcRenderer.invoke("umbra:launch-profile", payload),
  closeProfile: (profileId) => ipcRenderer.invoke("umbra:close-profile", profileId),
});
