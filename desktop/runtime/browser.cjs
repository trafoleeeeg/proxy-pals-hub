const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { startUrl, bookmarkletUrl } = require("./validation.cjs");
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
  importCookies = async () => { throw new Error("Импорт cookies недоступен"); },
  getBookmarks = () => [], addBookmark = async () => {}, removeBookmark = async () => {}, getExtensions = () => [],
  updateBookmark = async () => {}, reorderBookmarks = async () => {}, getBookmarkBarVisible = () => true,
  setBookmarkBarVisible = async () => {}, setExtensionPinned = async () => {}, openExtensionManager = () => {}, onTabsChanged = () => {},
  getZoomLevel = () => 0, setZoomLevel = async () => {},
  getProxies = () => [], getProxyFailover = () => false, switchProxy = async () => {}, setProxyFailover = async () => {},
  getLeaks = () => null, checkLeaks = async () => {},
}) {
  const { BrowserWindow, WebContentsView, session, ipcMain } = electron;
  let registry = handlers.get(ipcMain);
  if (!registry) {
    registry = new Map(); handlers.set(ipcMain, registry);
    ipcMain.handle("umbra-runtime:browser", (event, command) => {
      const handler = registry.get(event.sender);
       if (!handler || event.senderFrame !== event.sender.mainFrame) throw new Error("Недоверенный отправитель команды браузера");
      return handler(command);
    });
  }
  const shellSession = session.fromPartition(`profile-chrome-${randomUUID()}`, { cache: false });
  shellSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"] }, (_details, callback) => callback({ cancel: true }));
  shellSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  shellSession.setPermissionCheckHandler(() => false);
  const shell = new BrowserWindow({
    width: Math.min(fp.screen.width, 1600), height: Math.min(fp.screen.height + CHROME_HEIGHT, 1108),
    minWidth: 600, minHeight: 400, title: name, backgroundColor: "#111317", show: false, autoHideMenuBar: true,
    webPreferences: { session: shellSession, preload: path.join(__dirname, "browser-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false },
  });
  // Разворачиваем скрытое окно заранее, чтобы профиль появился сразу на весь
  // рабочий экран без заметного скачка из начального размера. В фоновом режиме
  // maximize пропускается: некоторые Linux window manager отображают окно.
  if (show) shell.maximize();
  // На Windows каждое окно профиля должно жить в панели задач отдельной иконкой,
  // а не группироваться со вторым окном Umbra. Для этого задаём окну собственный
  // AppUserModelID — проводник считает его самостоятельным приложением.
  if (process.platform === "win32" && typeof shell.setAppDetails === "function") {
    const slug = String(name || "profile").toLowerCase().replace(/[^a-z\d]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "profile";
    try {
      shell.setAppDetails({
        appId: `dev.umbra.desktop.profile.${slug}`,
        relaunchDisplayName: `Umbra — ${name}`,
      });
    } catch { /* панель задач не критична для работы профиля */ }
  }
  const tabs = new Map();
  let tabOrder = [];
  const recentlyClosed = [];
  const shellContents = shell.webContents;
  let activeId;
  let chromeHeight = CHROME_HEIGHT;
  // Меню и всплывающие панели рисуются поверх снимка страницы, а не сдвигают
  // её вниз: страница остаётся на месте, как в Chrome.
  let overlayOpen = false;
  let pageSnapshot = "";
  let ready = false;
  let error = "";
  let bookmarksOpen = false;
  let proxiesOpen = false;
  let leakChecking = false;
  let destroyed = false;
  let commandQueue = Promise.resolve();
  const active = () => tabs.get(activeId);
  const isHome = (tab) => !!tab?.pinnedHome;
  const isStartPage = (tab) => !!tab && tab.url === "about:blank";
  const homeTab = () => tabOrder.map((id) => tabs.get(id)).find((tab) => isHome(tab) && !tab.isDestroyed());
  // Тяжёлые списки (закладки со значками, расширения, прокси) отправляем в окно
  // только когда они действительно изменились, а сами обновления объединяем,
  // иначе поток событий загрузки страницы забивает канал и окно начинает тормозить.
  const heavySignatures = new Map();
  let publishTimer = null;
  let publishedAt = 0;
  const MIN_PUBLISH_INTERVAL = 60;
  function sendState() {
    if (shell.isDestroyed()) return;
    publishedAt = Date.now();
    layout();
    const currentUrl = active()?.webContents.getURL() || active()?.url || "";
    const bookmarks = getBookmarks();
    const payload = { name, activeId, error, home: isStartPage(active()), info: getInfo(),
       bookmarks, bookmarksOpen, proxiesOpen, proxies: getProxies(), proxyFailover: getProxyFailover(), leaks: getLeaks(), leakChecking, bookmarkBarVisible: getBookmarkBarVisible(), extensions: getExtensions(), bookmarked: bookmarks.some((item) => item.url === currentUrl),
      canRestoreTab: recentlyClosed.length > 0, find: active()?.find || null,
       overlay: overlayOpen, pageSnapshot: overlayOpen ? pageSnapshot : "",
       zoomPercent: active() ? Math.round(100 * Math.pow(1.2, active().webContents.getZoomLevel())) : 100,
      tabs: tabOrder.map((id) => tabs.get(id)).filter((tab) => tab && !tab.isDestroyed()).map((tab) => ({
      id: tab.id, url: tab.webContents.getURL() || tab.url, title: tab.webContents.getTitle(), favicon: tab.favicon || "", error: tab.error, pinnedHome: isHome(tab),
      loading: tab.webContents.isLoading(), canGoBack: tab.webContents.navigationHistory.canGoBack(), canGoForward: tab.webContents.navigationHistory.canGoForward(),
    })) };
    for (const key of ["bookmarks", "extensions", "proxies", "leaks", "info"]) {
      let signature;
      try { signature = JSON.stringify(payload[key]); } catch { signature = null; }
      if (signature !== null && heavySignatures.get(key) === signature) delete payload[key];
      else heavySignatures.set(key, signature);
    }
    shell.webContents.send("umbra-runtime:state", payload);
  }
  function publish() {
    if (shell.isDestroyed() || publishTimer) return;
    const wait = Math.max(0, MIN_PUBLISH_INTERVAL - (Date.now() - publishedAt));
    if (!wait) { sendState(); return; }
    publishTimer = setTimeout(() => { publishTimer = null; sendState(); }, wait);
    publishTimer.unref?.();
  }
  // Ответ на действие пользователя отправляем сразу, без задержки объединения.
  function flushPublish() {
    if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; }
    sendState();
  }
  // Снимок делается один раз при открытии панели: страница перестаёт
  // показываться, но визуально остаётся на месте и не прыгает.
  async function setOverlay(open) {
    const next = open === true;
    if (next === overlayOpen) return;
    pageSnapshot = "";
    if (next) {
      const tab = active();
      if (tab && !isStartPage(tab) && !bookmarksOpen && !proxiesOpen) {
        try {
          const image = await tab.webContents.capturePage?.();
          if (image && !(image.isEmpty?.() === true)) pageSnapshot = image.toDataURL();
        } catch { pageSnapshot = ""; }
      }
    }
    overlayOpen = next;
    layout();
    flushPublish();
  }
  function layout() {
    if (shell.isDestroyed()) return;
    const { width, height } = shell.getContentBounds();
    for (const tab of tabs.values()) {
      const top = chromeHeight;
      tab.view.setBounds({ x: 0, y: top, width: Math.max(1, width), height: Math.max(1, height - top) });
       tab.view.setVisible(tab.id === activeId && !isStartPage(tab) && !bookmarksOpen && !proxiesOpen && !overlayOpen);
    }
    positionExtensionPopup();
  }
  // Окно расширения открывается отдельным безрамочным окном поверх страницы —
  // как popup в Chrome: оно получает клики и закрывается при потере фокуса.
  const POPUP_SIZE = { width: 360, height: 480 };
  const OPTIONS_SIZE = { width: 900, height: 640 };
  let extensionPopup = null;
  let extensionPopupId = "";
  let extensionPopupAnchor = 0;
  let extensionPopupSize = { ...POPUP_SIZE };
  let extensionPopupFitTimer = null;
  let extensionPopupShownAt = 0;
  function positionExtensionPopup() {
    if (!extensionPopup || extensionPopup.isDestroyed() || shell.isDestroyed()) return;
    const area = shell.getContentBounds();
    const width = Math.round(Math.min(extensionPopupSize.width, Math.max(240, area.width - 16)));
    const height = Math.round(Math.min(extensionPopupSize.height, Math.max(140, area.height - chromeHeight - 12)));
    // Окно прижимается к своему значку на панели, как в Chrome.
    const right = extensionPopupAnchor > 0 ? Math.min(area.width - 8, extensionPopupAnchor) : area.width - 10;
    extensionPopup.setBounds({
      x: area.x + Math.max(8, Math.round(right - width)),
      y: area.y + chromeHeight,
      width, height,
    });
  }
  function closeExtensionPopup() {
    const popup = extensionPopup;
    extensionPopup = null; extensionPopupId = ""; extensionPopupAnchor = 0; extensionPopupSize = { ...POPUP_SIZE };
    clearTimeout(extensionPopupFitTimer); extensionPopupFitTimer = null;
    if (!popup) return;
    try { if (!popup.isDestroyed()) popup.destroy(); } catch { /* окно уже закрыто */ }
  }
  async function fitExtensionPopup(popup) {
    try {
      const size = await popup.webContents.executeJavaScript(
        "({w:Math.ceil(Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0)),h:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0))})",
        true);
      if (popup !== extensionPopup || popup.isDestroyed()) return;
      if (size && size.w > 40 && size.h > 40) {
        extensionPopupSize = { width: Math.min(520, Math.max(240, size.w + 2)), height: Math.min(600, Math.max(140, size.h + 2)) };
        positionExtensionPopup();
      }
    } catch { /* расширение не отдало размер — остаётся размер по умолчанию */ }
  }
  function refitExtensionPopup(popup, attempts = 8) {
    clearTimeout(extensionPopupFitTimer);
    if (!attempts || popup !== extensionPopup || popup.isDestroyed()) return;
    extensionPopupFitTimer = setTimeout(() => {
      void fitExtensionPopup(popup).finally(() => refitExtensionPopup(popup, attempts - 1));
    }, attempts === 8 ? 80 : 180);
    extensionPopupFitTimer.unref?.();
  }
  function openExtensionPopup(extension, anchor) {
    const page = extension?.popup || extension?.options || "";
    if (!extension?.runtimeId || !page) { error = "У этого расширения нет ни своего окна, ни страницы настроек"; return; }
    closeExtensionPopup();
    const popup = new BrowserWindow({
      parent: shell, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, show: false, backgroundColor: "#ffffff", autoHideMenuBar: true,
      webPreferences: { session: session.fromPartition(partition), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false },
    });
    extensionPopup = popup; extensionPopupId = extension.id;
    extensionPopupAnchor = Number.isFinite(anchor) && anchor > 0 ? Math.round(anchor) : 0;
    extensionPopupSize = extension.popup ? { ...POPUP_SIZE } : { ...OPTIONS_SIZE };
    positionExtensionPopup();
    popup.webContents.setWindowOpenHandler(({ url }) => {
      closeExtensionPopup();
      try { void openTab(startUrl(url)); } catch { /* неподдерживаемый адрес */ }
      return { action: "deny" };
    });
    popup.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); closeExtensionPopup(); }
    });
    popup.on("blur", () => {
      setTimeout(() => {
        if (popup === extensionPopup && Date.now() - extensionPopupShownAt > 250
          && BrowserWindow.getFocusedWindow?.() !== popup) closeExtensionPopup();
      }, 0);
    });
    popup.on("closed", () => { if (popup === extensionPopup) { extensionPopup = null; extensionPopupId = ""; } });
    popup.webContents.loadURL(`chrome-extension://${extension.runtimeId}/${page}`).then(async () => {
      if (popup !== extensionPopup || popup.isDestroyed()) return;
      // Содержимое, которое не поместилось, должно прокручиваться, а не обрезаться.
      await popup.webContents.insertCSS("html,body{overflow:auto!important}").catch(() => {});
      if (extension.popup) refitExtensionPopup(popup);
    }).catch((failure) => {
      closeExtensionPopup();
      error = String(failure?.code || "") === "ERR_FILE_NOT_FOUND"
        ? "Страница расширения не найдена — переустановите расширение"
        : "Не удалось открыть окно расширения";
      flushPublish();
    });
    extensionPopupShownAt = Date.now();
    popup.show();
    popup.focus();
    flushPublish();
  }
  function select(tab) {
    if (shell.isDestroyed() || !tab || tab.isDestroyed()) return;
    closeExtensionPopup();
    activeId = tab.id; layout();
    // Do not let focusing a tab reveal the shell while profiles are still
    // initializing (or while a native test deliberately keeps it hidden).
    if (show && shell.isVisible()) {
      if (isStartPage(tab)) shell.webContents.focus(); else tab.webContents.focus();
    }
    flushPublish();
    if (ready) onTabsChanged();
  }
  function closeTab(target) {
    if (!target || target.isDestroyed() || isHome(target)) return;
    const url = target.webContents.getURL() || target.url;
    if (url && url !== "about:blank") {
      recentlyClosed.push({ url, title: target.webContents.getTitle() || "" });
      if (recentlyClosed.length > 10) recentlyClosed.shift();
    }
    target.emit("close", { preventDefault() {} });
  }
  const KEEPS_EXTENSION_POPUP = new Set(["open-extension", "state", "chrome-height", "chrome-overlay-height", "overlay", "preconnect"]);
  async function command(message) {
    if (destroyed || !message || typeof message !== "object") return;
    error = "";
    // Любое другое действие закрывает окно расширения, как клик мимо popup в Chrome.
    if (!KEEPS_EXTENSION_POPUP.has(message.action)) closeExtensionPopup();
    const tab = active();
    let response;
    switch (message.action) {
      case "state": break;
      case "new": bookmarksOpen = false; proxiesOpen = false; await openTab("about:blank"); focusAddress(); break;
      case "home": bookmarksOpen = false; proxiesOpen = false; select(homeTab()); break;
      case "show-bookmarks": bookmarksOpen = true; proxiesOpen = false; layout(); break;
      case "hide-bookmarks": bookmarksOpen = false; layout(); break;
      case "show-proxies": proxiesOpen = true; bookmarksOpen = false; layout(); void checkConnection(); void command({ action: "check-leaks" }); break;
      case "hide-proxies": proxiesOpen = false; layout(); break;
      case "switch-proxy": {
        try { await switchProxy(String(message.id || "")); }
        catch (failure) { error = failure.message || "Не удалось переключить прокси"; }
        break;
      }
      case "check-leaks": {
        if (leakChecking) break;
        leakChecking = true;
        publish();
        try { await checkLeaks(); }
        catch { error = "Не удалось проверить утечки"; }
        finally { leakChecking = false; }
        break;
      }
      case "toggle-proxy-failover": await setProxyFailover(message.value === true); break;
      case "check-connection": await checkConnection(); break;
      case "select": bookmarksOpen = false; proxiesOpen = false; select(tabs.get(message.id)); break;
      case "close-tab": {
        const target = tabs.get(message.id || activeId);
        if (target && !isHome(target)) {
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
         if (!Array.isArray(message.ids) || message.ids.length !== tabOrder.length || new Set(message.ids).size !== tabOrder.length || message.ids.some((id) => !tabs.has(id)) || (homeTab() && message.ids[0] !== homeTab().id)) throw new Error("Некорректный порядок вкладок");
        tabOrder = [...message.ids]; if (ready) onTabsChanged(); break;
      }
      case "close-profile": await closeProfile(); break;
      case "import-cookies": {
        try {
          response = await importCookies(message.text);
          // Уже загруженный документ не повторяет HTTP-запрос сам по себе,
          // поэтому без reload сайт продолжал показывать прежнюю авторизацию.
          for (const open of tabs.values()) {
            if (!open.isDestroyed() && !isStartPage(open)) {
              try { open.webContents.reload(); } catch { /* cookie уже сохранён; вкладку можно обновить вручную */ }
            }
          }
        } catch (failure) {
          error = failure instanceof Error ? failure.message : "Не удалось импортировать cookies";
          response = { error };
        }
        break;
      }
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
        bookmarksOpen = false; proxiesOpen = false;
        if (saved.url.startsWith("javascript:")) {
          // Букмарклет выполняется на текущей странице, а не открывается как адрес.
          if (tab && !isStartPage(tab)) void tab.webContents.executeJavaScript(saved.url.slice("javascript:".length), true).catch(() => {});
          break;
        }
        if (message.newTab || !tab || isHome(tab)) await openTab(saved.url);
        else { tab.error = ""; void tab.loadURL(saved.url).catch(() => {}); }
        break;
      }
      case "remove-bookmark": await removeBookmark(message.id); break;
      case "add-bookmark": {
        let target;
        const raw = String(message.url || "").trim();
        try { target = raw.startsWith("javascript:") ? bookmarkletUrl(raw) : startUrl(raw); }
        catch { error = "Неверный адрес закладки"; break; }
        await addBookmark({ url: target, title: String(message.title || "").slice(0, 120) });
        break;
      }
      case "update-bookmark": {
        let target;
        if (message.url != null && String(message.url).trim()) {
          const raw = String(message.url).trim();
          try { target = raw.startsWith("javascript:") ? bookmarkletUrl(raw) : startUrl(raw); }
          catch { error = "Неверный адрес закладки"; break; }
        }
        await updateBookmark({ id: message.id, title: String(message.title || "").slice(0, 120), ...(target ? { url: target } : {}) });
        break;
      }
      case "find": {
        const query = String(message.value || "").slice(0, 200);
        if (!tab) break;
        if (!query) { tab.webContents.stopFindInPage("clearSelection"); break; }
        tab.webContents.findInPage(query, { findNext: !!message.next, forward: message.forward !== false });
        break;
      }
      case "find-stop": if (tab) tab.webContents.stopFindInPage("clearSelection"); break;
      case "zoom-in": case "zoom-out": case "zoom-reset": {
        if (!tab) break;
        const step = message.action === "zoom-in" ? 0.5 : -0.5;
         const level = message.action === "zoom-reset" ? 0 : Math.max(-3, Math.min(5, tab.webContents.getZoomLevel() + step));
         tab.webContents.setZoomLevel(level); await setZoomLevel(level);
        break;
      }
      case "reorder-bookmarks": if (Array.isArray(message.ids)) await reorderBookmarks(message.ids); break;
      case "toggle-bookmark-bar": await setBookmarkBarVisible(!getBookmarkBarVisible()); break;
      case "manage-extensions": openExtensionManager(); break;
      case "pin-extension": await setExtensionPinned(message.id, message.pinned === true); break;
      case "close-extension": break;
      case "open-extension": {
        if (extensionPopupId === message.id) { closeExtensionPopup(); break; }
        const extension = (getExtensions() || []).find((item) => item.id === message.id);
        if (!extension) { error = "Расширение не найдено"; break; }
        if (extension.failed) { error = `Расширение «${extension.name}» не загрузилось. Обновите или переустановите его.`; break; }
        openExtensionPopup(extension, Number(message.anchor));
        break;
      }
      case "overlay": {
        await setOverlay(message.value === true);
        return;
      }
      case "chrome-overlay-height": {
        await setOverlay(Math.round(Number(message.value) || 0) > 0);
        return;
      }
      // Заранее открываем соединение с сайтом, пока пользователь ещё вводит
      // адрес или наводится на закладку — страница начинает грузиться быстрее.
      case "preconnect": {
        const host = String(message.host || "").toLowerCase();
        if (/^[a-z\d][a-z\d.-]{2,253}$/.test(host) && host.includes(".")) {
          try { void session.fromPartition(partition).resolveHost?.(host)?.catch?.(() => {}); }
          catch { /* предзагрузка не обязательна */ }
        }
        return;
      }
      case "chrome-height": {
        const next = Number(message.value);
        const rounded = Math.round(next);
        if (Number.isFinite(next) && rounded >= 80 && rounded <= 180 && rounded !== chromeHeight) { chromeHeight = rounded; layout(); }
        return;
      }
      case "navigate": if (tab) { bookmarksOpen = false; proxiesOpen = false; tab.error = ""; const url = addressUrl(message.value); if (isHome(tab)) await openTab(url); else void tab.loadURL(url).catch(() => {}); } break;
      case "back": if (tab?.webContents.navigationHistory.canGoBack()) tab.webContents.navigationHistory.goBack(); break;
      case "forward": if (tab?.webContents.navigationHistory.canGoForward()) tab.webContents.navigationHistory.goForward(); break;
      case "reload": if (tab) { tab.error = ""; if (tab.webContents.isLoading()) tab.webContents.stop(); else tab.webContents.reload(); } break;
       default: throw new Error("Неизвестная команда браузера");
    }
    flushPublish();
    return response;
  }
  // В очередь попадают только команды, которые пишут сохранённое состояние
  // (закладки, прокси, расширения, масштаб). Всё остальное — действия
  // пользователя в интерфейсе — выполняется сразу, без ожидания фоновых задач.
  const SERIALIZED = new Set([
    "bookmark", "save-bookmark", "add-bookmark", "update-bookmark", "remove-bookmark",
    "reorder-bookmarks", "toggle-bookmark-bar", "pin-extension",
    "switch-proxy", "toggle-proxy-failover", "check-connection", "check-leaks",
    "zoom-in", "zoom-out", "zoom-reset", "close-profile", "import-cookies",
  ]);
  function runCommand(message) {
    return command(message).then((result) => result || {}).catch(() => {
      error = "Не удалось выполнить действие. Проверьте адрес и подключение прокси."; publish(); return { error };
    });
  }
  function dispatch(message) {
    // Switching existing tabs must not wait for a slow new tab or network check.
    if (message?.action === "select") { bookmarksOpen = false; proxiesOpen = false; select(tabs.get(message.id)); return Promise.resolve({}); }
    if (!SERIALIZED.has(message?.action)) return runCommand(message);
    commandQueue = commandQueue.then(() => runCommand(message));
    return commandQueue;
  }
  function focusAddress() {
    if (!shell.isDestroyed()) { shell.webContents.focus(); shell.webContents.send("umbra-runtime:state", { focusAddress: true }); }
  }
  function focusFind() {
    if (!shell.isDestroyed()) { shell.webContents.focus(); shell.webContents.send("umbra-runtime:state", { focusFind: true }); }
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
      if (key === "f") { event.preventDefault(); focusFind(); return; }
      if (key === "=" || key === "+") action = "zoom-in";
      if (key === "-") action = "zoom-out";
      if (key === "0") action = "zoom-reset";
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
  shell.on("move", positionExtensionPopup);
  shell.on("close", (event) => { event.preventDefault(); void closeProfile().catch(() => { error = "Не удалось сохранить профиль. Повторите закрытие."; publish(); }); });
  shell.on("closed", () => {
    destroyed = true;
    clearTimeout(publishTimer); publishTimer = null;
    closeExtensionPopup();
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
    createTab({ pinnedHome = false, activate = true } = {}) {
      if (destroyed || tabs.size >= (homeTab() ? 33 : 32)) throw new Error("Достигнут лимит вкладок профиля");
      if (pinnedHome && homeTab()) throw new Error("Стартовая вкладка уже открыта");
      const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } });
      const wc = view.webContents;
      const tab = new EventEmitter();
      Object.assign(tab, {
        id: randomUUID(), view, webContents: wc, url: "about:blank", error: "", pinnedHome,
        isDestroyed: () => wc.isDestroyed(),
        focus: () => { shell.focus(); select(tab); },
        show: () => { if (show && !shell.isDestroyed()) shell.show(); select(tab); },
        destroy: () => { tab.closing = true; if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); },
        async loadURL(url, options) {
          const target = startUrl(url, { allowBlank: true });
          if (pinnedHome && target !== "about:blank") throw new Error("Стартовую вкладку нельзя заменить сайтом");
          tab.url = target;
          tab.error = ""; publish();
          try { await wc.loadURL(tab.url, options); }
          catch (failure) { if (failure.code !== "ERR_ABORTED") tab.error = "Не удалось загрузить страницу. Проверьте адрес и подключение прокси."; throw failure; }
          finally { publish(); }
        },
      });
      tabs.set(tab.id, tab); if (pinnedHome) tabOrder.unshift(tab.id); else tabOrder.push(tab.id); shell.contentView.addChildView(view);
      if (activate || !activeId) select(tab); else { layout(); publish(); }
       wc.setZoomLevel(getZoomLevel());
      wc.on("before-input-event", shortcuts);
      wc.on("found-in-page", (_event, result) => { tab.find = { active: result.activeMatchOrdinal, total: result.matches }; publish(); });
      wc.on("context-menu", (_event, params) => {
        const Menu = electron.Menu;
        if (!Menu?.buildFromTemplate || shell.isDestroyed()) return;
        const items = [];
        if (params.linkURL) {
          items.push({ label: "Открыть ссылку в новой вкладке", click: () => { void openTab(params.linkURL); } });
          items.push({ label: "Копировать адрес ссылки", click: () => electron.clipboard?.writeText?.(params.linkURL) });
          items.push({ type: "separator" });
        }
        if (params.isEditable) items.push({ label: "Вырезать", role: "cut" }, { label: "Копировать", role: "copy" }, { label: "Вставить", role: "paste" }, { label: "Выделить всё", role: "selectAll" }, { type: "separator" });
        else if (params.selectionText) items.push({ label: "Копировать", role: "copy" }, { type: "separator" });
        items.push(
          { label: "Назад", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
          { label: "Вперёд", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
          { label: "Обновить", click: () => wc.reload() },
        );
        try { Menu.buildFromTemplate(items).popup({ window: shell }); } catch { /* меню необязательно */ }
      });
      wc.on("did-navigate", (_event, url) => { tab.url = url; tab.find = null; publish(); });
      wc.on("page-favicon-updated", async (_event, icons) => {
        const source = Array.isArray(icons) ? icons.find((icon) => /^https?:/i.test(icon)) : "";
        if (!source) return;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2500);
          const response = await wc.session.fetch(source, { signal: controller.signal }).finally(() => clearTimeout(timer));
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
        if (activeId === tab.id) select(homeTab() || tabs.get(tabOrder.at(-1)));
        tab.emit("closed"); publish(); if (ready) onTabsChanged();
      });
      return tab;
    },
    markReady: () => { ready = true; },
    getTabSnapshot: () => {
      const savedTabs = tabOrder.map((id) => tabs.get(id)).filter((tab) => tab && !tab.isDestroyed() && !isHome(tab));
      return {
        tabs: savedTabs.map((tab) => tab.webContents.getURL() || tab.url || "about:blank"),
        activeIndex: Math.max(0, savedTabs.findIndex((tab) => tab.id === activeId)),
      };
    },
    destroy: () => { if (!shell.isDestroyed()) shell.destroy(); },
  };
}

module.exports = { createProfileBrowser, addressUrl, CHROME_HEIGHT };
