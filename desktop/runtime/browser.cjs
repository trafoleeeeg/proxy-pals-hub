const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { startUrl } = require("./validation.cjs");
const { browserUrl } = require("./browser-ui.cjs");

const CHROME_HEIGHT = 90;
const handlers = new WeakMap();

function addressUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || !value.trim()) throw new Error("Введите адрес или поисковый запрос");
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
  updateBookmark = async () => {}, reorderBookmarks = async () => {}, getBookmarkBarVisible = () => true,
  setBookmarkBarVisible = async () => {}, openExtensionManager = () => {}, onTabsChanged = () => {},
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
  // Разворачиваем скрытое окно заранее, чтобы профиль появился сразу на весь
  // рабочий экран без заметного скачка из начального размера.
  shell.maximize();
  const tabs = new Map();
  let tabOrder = [];
  const recentlyClosed = [];
  const shellContents = shell.webContents;
  let activeId;
  let chromeHeight = CHROME_HEIGHT;
  let ready = false;
  let error = "";
  let destroyed = false;
  let commandQueue = Promise.resolve();
  const active = () => tabs.get(activeId);
  const isHome = (tab) => !!tab && tab.url === "about:blank";
  function publish() {
    if (shell.isDestroyed()) return;
    layout();
    const currentUrl = active()?.webContents.getURL() || active()?.url || "";
    const bookmarks = getBookmarks();
    shell.webContents.send("umbra-runtime:state", { name, activeId, error, home: isHome(active()), info: getInfo(),
      bookmarks, bookmarkBarVisible: getBookmarkBarVisible(), extensions: getExtensions(), bookmarked: bookmarks.some((item) => item.url === currentUrl),
      canRestoreTab: recentlyClosed.length > 0,
      tabs: tabOrder.map((id) => tabs.get(id)).filter((tab) => tab && !tab.isDestroyed()).map((tab) => ({
      id: tab.id, url: tab.webContents.getURL() || tab.url, title: tab.webContents.getTitle(), favicon: tab.favicon || "", error: tab.error,
      loading: tab.webContents.isLoading(), canGoBack: tab.webContents.navigationHistory.canGoBack(), canGoForward: tab.webContents.navigationHistory.canGoForward(),
    })) });
  }
  function layout() {
    if (shell.isDestroyed()) return;
    const { width, height } = shell.getContentBounds();
    for (const tab of tabs.values()) {
      tab.view.setBounds({ x: 0, y: chromeHeight, width: Math.max(1, width), height: Math.max(1, height - chromeHeight) });
      tab.view.setVisible(tab.id === activeId && !isHome(tab));
    }
  }
  function select(tab) {
    if (shell.isDestroyed() || !tab || tab.isDestroyed()) return;
    activeId = tab.id; layout();
    if (isHome(tab)) shell.webContents.focus(); else tab.webContents.focus();
    publish();
    if (ready) onTabsChanged();
  }
  function closeTab(target) {
    if (!target || target.isDestroyed()) return;
    const url = target.webContents.getURL() || target.url;
    if (url && url !== "about:blank") {
      recentlyClosed.push({ url, title: target.webContents.getTitle() || "" });
      if (recentlyClosed.length > 10) recentlyClosed.shift();
    }
    target.emit("close", { preventDefault() {} });
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
          closeTab(target);
        }
        break;
      }
      case "reopen-closed": {
        const closed = recentlyClosed.pop();
        if (closed) await openTab(closed.url);
        break;
      }
      case "reorder-tabs": {
        if (!Array.isArray(message.ids) || message.ids.length !== tabOrder.length || new Set(message.ids).size !== tabOrder.length || message.ids.some((id) => !tabs.has(id))) throw new Error("Invalid tab order");
        tabOrder = [...message.ids]; if (ready) onTabsChanged(); break;
      }
      case "close-profile": await closeProfile(); break;
      case "duplicate": {
        const url = tab?.webContents.getURL() || tab?.url || "about:blank";
        await openTab(url);
        break;
      }
      case "bookmark": {
        const url = tab?.webContents.getURL() || tab?.url || "";
        if (!url || url === "about:blank") { error = "Эту страницу нельзя добавить в закладки"; break; }
        const saved = getBookmarks().find((item) => item.url === url);
        if (saved) await removeBookmark(saved.id);
        else await addBookmark({ url: startUrl(url), title: tab?.webContents.getTitle() || "", favicon: tab?.favicon || "" });
        break;
      }
      case "save-bookmark": {
        const url = tab?.webContents.getURL() || tab?.url || "";
        if (!url || url === "about:blank") { error = "Эту страницу нельзя добавить в закладки"; break; }
        const saved = getBookmarks().find((item) => item.url === url);
        const title = String(message.title || tab?.webContents.getTitle() || "").trim().slice(0, 120);
        if (saved) await updateBookmark({ id: saved.id, title, favicon: tab?.favicon || "" });
        else await addBookmark({ url: startUrl(url), title, favicon: tab?.favicon || "" });
        break;
      }
      case "open-bookmark": {
        const saved = getBookmarks().find((item) => item.id === message.id);
        if (!saved) break;
        if (message.newTab || !tab) await openTab(saved.url);
        else { tab.error = ""; void tab.loadURL(saved.url).catch(() => {}); }
        break;
      }
      case "remove-bookmark": await removeBookmark(message.id); break;
      case "update-bookmark": await updateBookmark({ id: message.id, title: String(message.title || "").slice(0, 120) }); break;
      case "reorder-bookmarks": if (Array.isArray(message.ids)) await reorderBookmarks(message.ids); break;
      case "toggle-bookmark-bar": await setBookmarkBarVisible(!getBookmarkBarVisible()); break;
      case "manage-extensions": openExtensionManager(); break;
      case "chrome-height": {
        const next = Number(message.value);
        const rounded = Math.round(next);
        if (Number.isFinite(next) && rounded >= 80 && rounded <= 180 && rounded !== chromeHeight) { chromeHeight = rounded; layout(); }
        return;
      }
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
      error = "Не удалось выполнить действие. Проверьте адрес и подключение прокси."; publish(); return { error };
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
      if (key === "w") action = "close-tab";
      if (key === "t" && input.shift) action = "reopen-closed";
      else if (key === "t") action = "new";
      if (key === "r") action = "reload";
      if (key === "d") action = "bookmark";
      if (key === "b" && input.shift) action = "toggle-bookmark-bar";
      if (/^[1-9]$/.test(key)) {
        event.preventDefault(); const all = tabOrder.map((id) => tabs.get(id)).filter(Boolean);
        select(key === "9" ? all.at(-1) : all[Number(key) - 1]); return;
      }
      if (key === "tab") {
        event.preventDefault(); const all = tabOrder.map((id) => tabs.get(id)).filter(Boolean);
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
  shell.on("close", (event) => { event.preventDefault(); void closeProfile().catch(() => { error = "Не удалось сохранить профиль. Повторите закрытие."; publish(); }); });
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
      new Promise((_, reject) => { loadTimer = setTimeout(() => reject(new Error("Панель браузера не загрузилась")), 15000); }),
    ]);
  }
  catch (failure) { shell.destroy(); throw failure; }
  finally { clearTimeout(loadTimer); }
  return {
    shell, publish,
    createTab() {
      if (destroyed || tabs.size >= 32) throw new Error("Достигнут лимит вкладок профиля");
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
          catch (failure) { if (failure.code !== "ERR_ABORTED") tab.error = "Не удалось загрузить страницу. Проверьте адрес и подключение прокси."; throw failure; }
          finally { publish(); }
        },
      });
      tabs.set(tab.id, tab); tabOrder.push(tab.id); shell.contentView.addChildView(view); select(tab);
      wc.on("before-input-event", shortcuts);
      wc.on("did-navigate", (_event, url) => { tab.url = url; publish(); });
      wc.on("page-favicon-updated", async (_event, icons) => {
        const source = Array.isArray(icons) ? icons.find((icon) => /^https?:/i.test(icon)) : "";
        if (!source) return;
        try {
          const response = await wc.session.fetch(source);
          const type = response.headers.get("content-type") || "image/png";
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!type.startsWith("image/") || bytes.length > 256 * 1024 || wc.isDestroyed()) return;
          tab.favicon = `data:${type};base64,${bytes.toString("base64")}`; publish();
        } catch { /* favicon is optional and never falls back outside the profile session */ }
      });
      for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) wc.on(event, publish);
      wc.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) { tab.error = "Не удалось загрузить страницу. Проверьте адрес и подключение прокси."; publish(); } });
      wc.on("render-process-gone", () => { tab.error = "Вкладка остановилась. Обновите страницу и повторите попытку."; publish(); });
      wc.on("destroyed", () => {
        tabs.delete(tab.id);
        tabOrder = tabOrder.filter((id) => id !== tab.id);
        if (!shell.isDestroyed()) shell.contentView.removeChildView(view);
        if (activeId === tab.id) select(tabs.get(tabOrder.at(-1)));
        tab.emit("closed"); publish(); if (ready) onTabsChanged();
      });
      return tab;
    },
    markReady: () => { ready = true; },
    getTabSnapshot: () => ({
      tabs: tabOrder.map((id) => tabs.get(id)).filter((tab) => tab && !tab.isDestroyed()).map((tab) => tab.webContents.getURL() || tab.url || "about:blank"),
      activeIndex: Math.max(0, tabOrder.indexOf(activeId)),
    }),
    destroy: () => { if (!shell.isDestroyed()) shell.destroy(); },
  };
}

module.exports = { createProfileBrowser, addressUrl, CHROME_HEIGHT };
