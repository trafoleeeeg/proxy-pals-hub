const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { startUrl } = require("./validation.cjs");
const { browserUrl } = require("./browser-ui.cjs");

const CHROME_HEIGHT = 108;
const handlers = new WeakMap();

function addressUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || !value.trim()) throw new Error("Enter an address");
  value = value.trim();
  if (value === "about:blank") return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[\w.-]+:\d+(?:\/|$)/.test(value)) return startUrl(value);
  if (!/\s/.test(value) && /^(?:localhost|\[[a-f\d:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return startUrl(`${/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(value) ? "http" : "https"}://${value}`);
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

async function createProfileBrowser(electron, {
  name, fp, partition, openTab, closeProfile, getInfo = () => ({}), checkConnection = async () => {}, show = true,
  getBookmarks = () => [], addBookmark = async () => {}, removeBookmark = async () => {}, getExtensions = () => [],
}) {
  const { BrowserWindow, WebContentsView, session, ipcMain } = electron;
  let registry = handlers.get(ipcMain);
  if (!registry) {
    registry = new Map(); handlers.set(ipcMain, registry);
    ipcMain.handle("umbra-runtime:browser", (event, command) => {
      const handler = registry.get(event.sender);
      if (!handler || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted browser sender");
      return handler(command);
    });
  }
  const shellSession = session.fromPartition(`profile-chrome-${randomUUID()}`, { cache: false });
  shellSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"] }, (_details, callback) => callback({ cancel: true }));
  shellSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  shellSession.setPermissionCheckHandler(() => false);
  const shell = new BrowserWindow({
    width: Math.min(fp.screen.width, 1600), height: Math.min(fp.screen.height + CHROME_HEIGHT, 1108),
    minWidth: 600, minHeight: 400, title: name, backgroundColor: "#111217", show: false, autoHideMenuBar: true,
    webPreferences: { session: shellSession, preload: path.join(__dirname, "browser-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false },
  });
  const tabs = new Map();
  const shellContents = shell.webContents;
  let activeId;
  let error = "";
  let destroyed = false;
  let commandQueue = Promise.resolve();
  const active = () => tabs.get(activeId);
  const isHome = (tab) => !!tab && tab.url === "about:blank";
  function publish() {
    if (shell.isDestroyed()) return;
    layout();
    shell.webContents.send("umbra-runtime:state", { name, activeId, error, home: isHome(active()), info: getInfo(), tabs: [...tabs.values()].filter((tab) => !tab.isDestroyed()).map((tab) => ({
      id: tab.id, url: tab.webContents.getURL() || tab.url, title: tab.webContents.getTitle(), error: tab.error,
      loading: tab.webContents.isLoading(), canGoBack: tab.webContents.navigationHistory.canGoBack(), canGoForward: tab.webContents.navigationHistory.canGoForward(),
    })) });
  }
  function layout() {
    if (shell.isDestroyed()) return;
    const { width, height } = shell.getContentBounds();
    for (const tab of tabs.values()) {
      tab.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: Math.max(1, width), height: Math.max(1, height - CHROME_HEIGHT) });
      tab.view.setVisible(tab.id === activeId && !isHome(tab));
    }
  }
  function select(tab) {
    if (shell.isDestroyed() || !tab || tab.isDestroyed()) return;
    activeId = tab.id; layout();
    if (isHome(tab)) shell.webContents.focus(); else tab.webContents.focus();
    publish();
  }
  async function command(message) {
    if (destroyed || !message || typeof message !== "object") return;
    error = "";
    const tab = active();
    switch (message.action) {
      case "state": break;
      case "new": await openTab("about:blank"); focusAddress(); break;
      case "home": if (tab) await tab.loadURL("about:blank"); break;
      case "check-connection": await checkConnection(); break;
      case "select": select(tabs.get(message.id)); break;
      case "close-tab": {
        const target = tabs.get(message.id || activeId);
        if (target) {
          if (tabs.size === 1) await openTab("about:blank");
          target.emit("close", { preventDefault() {} });
        }
        break;
      }
      case "close-profile": await closeProfile(); break;
      case "navigate": if (tab) { tab.error = ""; void tab.loadURL(addressUrl(message.value)).catch(() => {}); } break;
      case "back": if (tab?.webContents.navigationHistory.canGoBack()) tab.webContents.navigationHistory.goBack(); break;
      case "forward": if (tab?.webContents.navigationHistory.canGoForward()) tab.webContents.navigationHistory.goForward(); break;
      case "reload": if (tab) { tab.error = ""; if (tab.webContents.isLoading()) tab.webContents.stop(); else tab.webContents.reload(); } break;
      default: throw new Error("Unknown browser command");
    }
    publish();
  }
  function dispatch(message) {
    // Switching existing tabs must not wait for a slow new tab or network check.
    if (message?.action === "select") { select(tabs.get(message.id)); return Promise.resolve({}); }
    commandQueue = commandQueue.then(() => command(message)).then(() => ({})).catch(() => {
      error = "Unable to complete this action. Check the address or proxy connection."; publish(); return { error };
    });
    return commandQueue;
  }
  function focusAddress() {
    if (!shell.isDestroyed()) { shell.webContents.focus(); shell.webContents.send("umbra-runtime:state", { focusAddress: true }); }
  }
  function shortcuts(event, input) {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    let action;
    if (input.control || input.meta) {
      if (key === "l") { event.preventDefault(); focusAddress(); return; }
      if (key === "t") action = "new";
      if (key === "w") action = "close-tab";
      if (key === "r") action = "reload";
      if (key === "tab") {
        event.preventDefault(); const all = [...tabs.values()];
        select(all[(all.indexOf(active()) + (input.shift ? -1 : 1) + all.length) % all.length]); return;
      }
    }
    if (key === "f5") action = "reload";
    if (input.alt && key === "arrowleft") action = "back";
    if (input.alt && key === "arrowright") action = "forward";
    if (action) { event.preventDefault(); void dispatch({ action }); }
  }
  registry.set(shellContents, dispatch);
  shell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-navigate", "will-redirect", "will-attach-webview"]) shell.webContents.on(event, (event) => event.preventDefault());
  shell.webContents.on("before-input-event", shortcuts);
  shell.webContents.on("render-process-gone", () => { if (!destroyed) void closeProfile().catch(() => {}); });
  shell.on("resize", layout);
  shell.on("close", (event) => { event.preventDefault(); void closeProfile().catch(() => { error = "Profile could not be saved. Close again to retry."; publish(); }); });
  shell.on("closed", () => {
    destroyed = true;
    registry.delete(shellContents);
    for (const tab of [...tabs.values()]) tab.destroy();
    if (!registry.size) { ipcMain.removeHandler("umbra-runtime:browser"); handlers.delete(ipcMain); }
  });
  let loadTimer;
  try {
    await Promise.race([
      shell.loadURL(browserUrl()),
      new Promise((_, reject) => { loadTimer = setTimeout(() => reject(new Error("Browser toolbar did not load")), 15000); }),
    ]);
  }
  catch (failure) { shell.destroy(); throw failure; }
  finally { clearTimeout(loadTimer); }
  return {
    shell, publish,
    createTab() {
      if (destroyed || tabs.size >= 32) throw new Error("Profile tab limit reached");
      const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } });
      const wc = view.webContents;
      const tab = new EventEmitter();
      Object.assign(tab, {
        id: randomUUID(), view, webContents: wc, url: "about:blank", error: "",
        isDestroyed: () => wc.isDestroyed(),
        focus: () => { shell.focus(); select(tab); },
        show: () => { if (show && !shell.isDestroyed()) shell.show(); select(tab); },
        destroy: () => { tab.closing = true; if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); },
        async loadURL(url, options) {
          tab.url = startUrl(url, { allowBlank: true }); tab.error = ""; publish();
          try { await wc.loadURL(tab.url, options); }
          catch (failure) { if (failure.code !== "ERR_ABORTED") tab.error = "Page could not be loaded. Check the address or proxy connection."; throw failure; }
          finally { publish(); }
        },
      });
      tabs.set(tab.id, tab); shell.contentView.addChildView(view); select(tab);
      wc.on("before-input-event", shortcuts);
      wc.on("did-navigate", (_event, url) => { tab.url = url; publish(); });
      for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) wc.on(event, publish);
      wc.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) { tab.error = "Page could not be loaded. Check the address or proxy connection."; publish(); } });
      wc.on("render-process-gone", () => { tab.error = "This tab stopped. Reload to try again."; publish(); });
      wc.on("destroyed", () => {
        tabs.delete(tab.id);
        if (!shell.isDestroyed()) shell.contentView.removeChildView(view);
        if (activeId === tab.id) select([...tabs.values()].at(-1));
        tab.emit("closed"); publish();
      });
      return tab;
    },
    destroy: () => { if (!shell.isDestroyed()) shell.destroy(); },
  };
}

module.exports = { createProfileBrowser, addressUrl, CHROME_HEIGHT };
