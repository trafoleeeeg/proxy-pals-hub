const { contextBridge, ipcRenderer } = require("electron");
const readArgument = (prefix) => process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
const version = readArgument("--umbra-version=") || "unknown";
const trustedOrigin = decodeURIComponent(readArgument("--umbra-app-origin=") || "");

if (window.location.origin === trustedOrigin) contextBridge.exposeInMainWorld("umbra", {
  isDesktop: true,
  version,
  platform: process.platform,
  launchProfile: (payload) => ipcRenderer.invoke("umbra:launch-profile", payload),
  closeProfile: (profileId) => ipcRenderer.invoke("umbra:close-profile", profileId),
  profileCookies: (profileId) => ipcRenderer.invoke("umbra:profile-cookies", profileId),
  listRunningProfiles: () => ipcRenderer.invoke("umbra:list-running-profiles"),
  pendingProfileClosures: () => ipcRenderer.invoke("umbra:pending-profile-closures"),
  acknowledgeProfileClosure: (snapshotId) => ipcRenderer.invoke("umbra:acknowledge-profile-closure", snapshotId),
  archiveProfileClosure: (snapshotId) => ipcRenderer.invoke("umbra:archive-profile-closure", snapshotId),
  onProfileClosed: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("umbra:profile-closed", handler);
    return () => ipcRenderer.removeListener("umbra:profile-closed", handler);
  },
  pushBrowserSettings: (settings) => ipcRenderer.invoke("umbra:browser-settings-push", settings),
  pushBookmarkDefaults: (settings) => ipcRenderer.invoke("umbra:bookmark-defaults-push", settings),
  onBrowserSettingsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("umbra:browser-settings-changed", handler);
    return () => ipcRenderer.removeListener("umbra:browser-settings-changed", handler);
  },
  openExternal: (url) => ipcRenderer.invoke("umbra:open-external", url),
  checkProxy: (payload) => ipcRenderer.invoke("umbra:check-proxy", payload),
  listExtensions: () => ipcRenderer.invoke("umbra:extensions-list"),
  readProxyClipboard: () => ipcRenderer.invoke("umbra:proxy-clipboard"),
  addExtension: () => ipcRenderer.invoke("umbra:extensions-add"),
  addExtensionFromUrl: (url) => ipcRenderer.invoke("umbra:extensions-add-url", url),
  updateExtension: (id) => ipcRenderer.invoke("umbra:extensions-update", id),
  removeExtension: (id) => ipcRenderer.invoke("umbra:extensions-remove", id),

  // Обновление в один клик.
  appVersion: () => ipcRenderer.invoke("umbra:app-version"),
  checkUpdate: () => ipcRenderer.invoke("umbra:check-update"),
  updateState: () => ipcRenderer.invoke("umbra:update-state"),
  downloadUpdate: () => ipcRenderer.invoke("umbra:download-update"),
  installUpdate: () => ipcRenderer.invoke("umbra:install-update"),
  onUpdateStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("umbra:update", handler);
    return () => ipcRenderer.removeListener("umbra:update", handler);
  },
});
