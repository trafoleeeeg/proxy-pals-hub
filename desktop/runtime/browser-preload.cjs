const { contextBridge, ipcRenderer } = require("electron");

// This preload belongs only to the local browser chrome, never to a website.
contextBridge.exposeInMainWorld("profileBrowser", {
  command: (command) => ipcRenderer.invoke("umbra-runtime:browser", command),
  subscribe: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("umbra-runtime:state", (_event, state) => callback(state));
  },
});
