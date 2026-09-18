const { profileId, startUrl, revision } = require("./validation.cjs");
const { createProfileBrowser } = require("./browser.cjs");
const { createRuntimeProxy, blockSession } = require("./proxy.cjs");
const { createCookieStore, initializeCookies, canonicalCookies } = require("./cookies.cjs");
const { createTabStore, sanitizeTabs } = require("./tabs.cjs");
const { createBookmarkStore, defaultBookmarks, sanitizeBookmarks } = require("./bookmarks.cjs");
const { normalizeFingerprint, applyFingerprint } = require("./fingerprint.cjs");
const { sanitizeBrowserSettings } = require("./browser-settings.cjs");
const { SAFE_WEBRTC } = require("./leak-check.cjs");
const { createFaviconLoader } = require("./favicons.cjs");

function createProfileRuntime(electron, options = {}) {
  const { session, app, safeStorage } = electron;
  const createBrowser = options.createBrowser || createProfileBrowser;
  const setupProxy = options.setupProxy || createRuntimeProxy;
  const configureFingerprint = options.applyFingerprint || applyFingerprint;
  const profiles = new Map();
  let shuttingDown = false;
  let store;
  let tabStoreRef;
  let bookmarkStoreRef;
  const cookieStore = () => store ||= options.cookieStore || createCookieStore({ safeStorage, userData: app.getPath("userData") });
  const tabStore = () => tabStoreRef ||= options.tabStore || createTabStore({ safeStorage, userData: app.getPath("userData") });
  const bookmarkStore = () => bookmarkStoreRef ||= options.bookmarkStore || createBookmarkStore({ safeStorage, userData: app.getPath("userData") });
  const extensionStore = options.extensionStore;
  const favicons = options.faviconLoader || (electron.net ? createFaviconLoader({ net: electron.net }) : null);

  function status(entry) {
    return {
      profileId: entry.profileId, name: entry.name, lockToken: entry.lockToken, deviceId: entry.deviceId,
      state: entry.state, cookiesUpdatedAt: entry.cookiesUpdatedAt || null,
      windowCount: entry.browser && !entry.primary.isDestroyed() ? 1 : 0,
      tabCount: entry.windows.size, startedAt: entry.startedAt,
      diagnostics: {
        proxy: entry.proxyRuntime ? { ...entry.proxyRuntime.diagnostics } : { mode: "blocked" },
        fingerprint: entry.fingerprintDiagnostics || null,
        cookieSource: entry.cookieSource || null,
        cookiePersistence: "safeStorage-encrypted-local-snapshot",
        extensions: { loaded: entry.extensionsLoaded?.size || 0, errors: entry.extensionErrors?.length || 0 },
        lastError: entry.lastError || null,
      },
    };
  }

  function snapshot(entry) {
    entry.snapshotQueue = entry.snapshotQueue.catch(() => {}).then(async () => {
      await entry.ses.cookies.flushStore();
      entry.ses.flushStorageData();
      const cookies = await entry.ses.cookies.get({});
      const signature = canonicalCookies(cookies);
      if (signature !== entry.cookieSignature) {
        const next = new Date(Math.max(Date.now(), Date.parse(entry.cookiesUpdatedAt || 0) + 1)).toISOString();
        await cookieStore().write(entry.profileId, cookies, next);
        entry.cookiesUpdatedAt = next;
        entry.cookieSignature = signature;
      }
      return { profileId: entry.profileId, lockToken: entry.lockToken, deviceId: entry.deviceId, cookies: signature, cookiesUpdatedAt: entry.cookiesUpdatedAt };
    }).catch(() => { throw new Error("Unable to flush encrypted profile cookies"); });
    return entry.snapshotQueue;
  }

  function openTabUrls(entry) {
    const urls = [];
    for (const win of entry.windows) {
      if (win.isDestroyed()) continue;
      let current = "";
      try { current = win.webContents.getURL(); } catch { current = ""; }
      urls.push(current || win.url || "about:blank");
    }
    return sanitizeTabs(urls);
  }

  function persistTabs(entry) {
    const state = entry.browser?.getTabSnapshot?.();
    const tabs = state?.tabs || openTabUrls(entry);
    if (!tabs.length) return Promise.resolve();
    entry.tabQueue = (entry.tabQueue || Promise.resolve())
      .catch(() => {})
      .then(() => tabStore().write(entry.profileId, tabs, state?.activeIndex || 0))
      .catch(() => { entry.lastError = "Tab snapshot failed"; });
    return entry.tabQueue;
  }

  function recordTabs(entry) {
    if (entry.state !== "running" || entry.closingRequested) return;
    clearTimeout(entry.tabTimer);
    entry.tabTimer = setTimeout(() => { void persistTabs(entry); }, 600);
    entry.tabTimer.unref?.();
  }

  function watchCookies(entry) {
    const checkpoint = () => {
      if (entry.state !== "running") return;
      snapshot(entry).catch(() => { entry.lastError = "Cookie checkpoint failed"; });
      void persistTabs(entry);
    };
    entry.cookieChanged = () => {
      clearTimeout(entry.cookieTimer);
      entry.cookieTimer = setTimeout(checkpoint, 300);
      entry.cookieTimer.unref?.();
    };
    entry.ses.cookies.on("changed", entry.cookieChanged);
    entry.checkpointTimer = setInterval(checkpoint, 30000);
    entry.checkpointTimer.unref?.();
  }

  function unwatchCookies(entry) {
    clearTimeout(entry.cookieTimer);
    clearTimeout(entry.tabTimer);
    clearInterval(entry.checkpointTimer);
    if (entry.cookieChanged) entry.ses.cookies.removeListener("changed", entry.cookieChanged);
  }

  async function navigate(win, url, loadOptions) {
    let timer;
    try {
      await Promise.race([
        win.loadURL(url, loadOptions),
        new Promise((_, reject) => { timer = setTimeout(() => { if (!win.isDestroyed()) win.webContents.stop(); reject(new Error("Navigation timed out")); }, 30000); }),
      ]);
    } catch { throw new Error("Profile navigation failed; no direct fallback was used"); }
    finally { clearTimeout(timer); }
  }

  function browserOptions(entry) {
    return {
      name: entry.name, fp: entry.fp, partition: entry.partition, show: options.show !== false,
      getInfo: () => ({
        name: entry.name, profileId: entry.profileId, startedAt: entry.startedAt,
        hasProxy: !!entry.proxyTarget, proxy: entry.proxyLabel,
        ip: entry.connection?.ip, country: entry.connection?.country, city: entry.connection?.city,
        latency: entry.connection?.latency, checkedAt: entry.checkedAt, checking: !!entry.checkJob,
        checkError: entry.connection && !entry.connection.ok ? "Прокси недоступен. Прямого обхода нет." : null,
        timezone: entry.fp.timezone, languages: entry.fp.languages.join(", "),
        screen: entry.fp.screen.width + " × " + entry.fp.screen.height,
        hardware: entry.fp.hardwareConcurrency + " ядер · " + entry.fp.deviceMemory + " ГБ",
        chrome: entry.fp.chromeVersion || process.versions.chrome,
        extensions: (entry.extensionsLoaded?.size || 0) + " подключено" + (entry.extensionErrors?.length ? " · есть ошибки" : ""),
        cookies: entry.cookiesUpdatedAt ? "Сохранены с шифрованием" : "Подготовка",
      }),
      checkConnection: () => checkConnection(entry),
      openTab: (target) => {
        const pending = makeWindow(entry, target).finally(() => entry.pendingWindows.delete(pending));
        entry.pendingWindows.add(pending);
        return pending;
      },
      closeProfile: () => closeProfileWindow(entry.profileId),
      onTabsChanged: () => recordTabs(entry),
      getBookmarks: () => allBookmarks(entry),
      getBookmarkBarVisible: () => entry.bookmarkBarVisible !== false,
      getExtensions: () => entry.extensionList || [],
      getZoomLevel: () => entry.zoomLevel || 0,
      setZoomLevel: async (level) => { entry.zoomLevel = level; notifyBrowserSettings(entry); },
      setExtensionPinned: async (id, pinned) => {
        if (!extensionStore?.setPinned) return;
        await extensionStore.setPinned(id, pinned);
        await reloadExtensionList(entry);
        notifyBrowserSettings(entry);
      },
      addBookmark: (bookmark) => allBookmarks(entry).some((item) => item.url === bookmark.url)
        ? Promise.resolve(allBookmarks(entry))
        : saveBookmarks(entry, [...(entry.bookmarks || []), { ...bookmark }]),
      updateBookmark: (bookmark) => (entry.presetBookmarks || []).some((item) => item.id === bookmark.id)
        ? Promise.resolve(allBookmarks(entry))
        : saveBookmarks(entry, (entry.bookmarks || []).map((item) => item.id === bookmark.id
        ? { ...item, title: bookmark.title, url: bookmark.url || item.url, favicon: bookmark.url && bookmark.url !== item.url ? "" : (bookmark.favicon || item.favicon) }
        : item)),
      removeBookmark: (id) => (entry.presetBookmarks || []).some((item) => item.id === id)
        ? Promise.resolve(allBookmarks(entry))
        : saveBookmarks(entry, (entry.bookmarks || []).filter((item) => item.id !== id)),
      reorderBookmarks: (ids) => {
        const byId = new Map((entry.bookmarks || []).map((item) => [item.id, item]));
        return saveBookmarks(entry, ids.map((id) => byId.get(id)).filter(Boolean));
      },
      setBookmarkBarVisible: (visible) => {
        entry.bookmarkBarVisible = !!visible;
        return saveBookmarks(entry, entry.bookmarks || []);
      },
      openExtensionManager: () => { app?.emit?.("umbra:manage-extensions"); },
      getLeaks: () => entry.leaks || null,
      checkLeaks: () => runLeakAudit(entry),
      getProxies: () => safeProxyList(entry),
      getProxyFailover: () => entry.proxyFailover === true,
      switchProxy: (id) => switchProxy(entry, id),
      setProxyFailover: async (value) => { entry.proxyFailover = value === true; notifyBrowserSettings(entry); },
    };
  }

  // Проверка утечек DNS/WebRTC/IP: при утечке трафик профиля блокируется,
  // пока прокси не будет исправлен.
  async function runLeakAudit(entry) {
    if (!options.auditLeaks || entry.state !== "running") return entry.leaks || null;
    if (entry.leakJob) return entry.leakJob;
    entry.leakJob = Promise.resolve()
      .then(() => options.auditLeaks({ ses: entry.ses, hasProxy: !!entry.proxyTarget, webrtcPolicy: entry.webrtcPolicy }))
      .then((result) => {
        entry.leaks = { ...result, checkedAt: new Date().toISOString() };
        if (result.leaked) entry.lastError = "Обнаружена утечка: трафик профиля заблокирован";
        return entry.leaks;
      })
      .catch(() => {
        entry.leaks = { ok: false, leaked: false, checks: [{ id: "ip", label: "Проверка", state: "error", detail: "Не удалось выполнить проверку" }], checkedAt: new Date().toISOString() };
        return entry.leaks;
      })
      .finally(() => { entry.leakJob = null; });
    return entry.leakJob;
  }

  // Пароли прокси остаются в основном процессе: в окно профиля уходит
  // только безопасное описание сервера.
  function safeProxyList(entry) {
    return (entry.proxyPool || []).map((item) => ({
      id: item.id, label: item.label || proxyLabel(item), protocol: item.protocol, host: item.host, port: item.port,
      country: item.country || "", city: item.city || "", active: item.id === entry.activeProxyId,
      ip: item.id === entry.activeProxyId ? entry.connection?.ip || "" : "",
      latency: item.id === entry.activeProxyId ? entry.connection?.latency ?? null : null,
      ok: item.id === entry.activeProxyId ? entry.connection?.ok === true : null,
      checking: item.id === entry.activeProxyId && !!entry.checkJob,
    }));
  }

  function proxyLabel(proxy) {
    return proxy ? String(proxy.protocol).toUpperCase() + " · " + proxy.host + ":" + proxy.port : "Без прокси";
  }

  function sanitizeProxyPool(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 200).flatMap((item) => {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id)) return [];
      if (typeof item.host !== "string" || !item.host || !["http", "https", "socks5"].includes(item.protocol)) return [];
      const port = Number(item.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
      return [{
        id: item.id, label: typeof item.label === "string" ? item.label.slice(0, 200) : "",
        protocol: item.protocol, host: item.host, port,
        username: typeof item.username === "string" ? item.username : null,
        password: typeof item.password === "string" ? item.password : "",
        country: typeof item.country === "string" ? item.country.slice(0, 80) : "",
        city: typeof item.city === "string" ? item.city.slice(0, 80) : "",
      }];
    });
  }

  function proxyConnectionOf(item) {
    return item ? { protocol: item.protocol, host: item.host, port: item.port, username: item.username, password: item.password } : null;
  }

  function matchPoolId(entry, proxy) {
    if (!proxy) return null;
    const found = (entry.proxyPool || []).find((item) => item.protocol === proxy.protocol && item.host === proxy.host && Number(item.port) === Number(proxy.port));
    return found ? found.id : null;
  }

  async function switchProxy(entry, id) {
    if (entry.state !== "running" || entry.closingRequested) throw new Error("Профиль не готов к смене прокси");
    const target = (entry.proxyPool || []).find((item) => item.id === id);
    if (!target) throw new Error("Этот прокси недоступен для профиля");
    if (entry.proxySwitching) throw new Error("Смена прокси уже выполняется");
    if (target.id === entry.activeProxyId) return true;
    entry.proxySwitching = true;
    const previousRuntime = entry.proxyRuntime;
    const previousTarget = entry.proxyTarget || null;
    const previousId = entry.activeProxyId || null;
    const config = proxyConnectionOf(target);
    try {
      blockSession(entry.ses);
      if (previousRuntime) await previousRuntime.dispose().catch(() => {});
      entry.proxyRuntime = await setupProxy(entry.ses, config);
      entry.proxyTarget = config;
      entry.activeProxyId = target.id;
      entry.proxyLabel = proxyLabel(config);
      entry.webrtcPolicy = SAFE_WEBRTC;
      try { entry.ses.setWebRTCIPHandlingPolicy?.(SAFE_WEBRTC); } catch { /* политика недоступна в этой сборке */ }
      entry.leaks = null;
      entry.connection = null;
      entry.checkedAt = null;
      notifyBrowserSettings(entry);
      entry.browser?.publish?.();
      void checkConnection(entry);
      return true;
    } catch {
      // Трафик остаётся заблокированным, пока прежний сервер не поднимется снова.
      try {
        entry.proxyRuntime = await setupProxy(entry.ses, previousTarget);
        entry.proxyTarget = previousTarget;
        entry.activeProxyId = previousId;
        entry.proxyLabel = proxyLabel(previousTarget);
      } catch {
        entry.proxyRuntime = null;
        blockSession(entry.ses);
      }
      entry.lastError = "Не удалось переключить прокси";
      entry.browser?.publish?.();
      throw new Error("Не удалось переключить прокси. Трафик остался на прежнем сервере");
    } finally { entry.proxySwitching = false; }
  }

  async function failoverProxy(entry) {
    const pool = entry.proxyPool || [];
    if (!entry.proxyFailover || entry.failoverRunning || entry.state !== "running" || pool.length < 2) return null;
    if (entry.lastFailoverAt && Date.now() - entry.lastFailoverAt < 30000) return null;
    entry.failoverRunning = true;
    entry.lastFailoverAt = Date.now();
    try {
      const start = pool.findIndex((item) => item.id === entry.activeProxyId);
      for (let step = 1; step <= pool.length; step++) {
        const candidate = pool[(start + step + pool.length) % pool.length];
        if (!candidate || candidate.id === entry.activeProxyId) continue;
        try {
          const probe = options.checkProxy ? await options.checkProxy(proxyConnectionOf(candidate)) : { ok: true };
          if (!probe.ok) continue;
          await switchProxy(entry, candidate.id);
          return candidate.id;
        } catch { /* пробуем следующий сервер */ }
      }
      return null;
    } finally { entry.failoverRunning = false; }
  }

  function saveBookmarks(entry, list) {
    entry.bookmarkQueue = (entry.bookmarkQueue || Promise.resolve()).catch(() => {}).then(async () => {
      const state = await bookmarkStore().write(entry.profileId, { bookmarks: list, barVisible: entry.bookmarkBarVisible !== false });
      entry.bookmarks = state.bookmarks;
      notifyBrowserSettings(entry);
      return entry.bookmarks;
    }).catch(() => { entry.lastError = "Bookmark save failed"; return entry.bookmarks || []; });
    return entry.bookmarkQueue;
  }

  function allBookmarks(entry) {
    const presets = (entry.presetBookmarks || []).map((item) => ({ ...item, managed: true }));
    const presetUrls = new Set(presets.map((item) => item.url));
    const list = [...presets, ...(entry.bookmarks || []).filter((item) => !presetUrls.has(item.url))];
    if (!favicons) return list;
    return list.map((item) => item.favicon ? item : { ...item, favicon: favicons.get(item.url) || "" });
  }

  // Подгружаем настоящие значки сайтов для закладок без картинки — через
  // сессию профиля, то есть через его прокси.
  function loadBookmarkIcons(entry) {
    if (!favicons || !entry.ses || entry.iconJob) return;
    const missing = allBookmarks(entry).filter((item) => !item.favicon).map((item) => item.url);
    if (!missing.length) return;
    entry.iconJob = favicons.load(entry.ses, missing, () => entry.browser?.publish?.())
      .catch(() => {})
      .finally(() => { entry.iconJob = null; entry.browser?.publish?.(); });
  }

  function browserSettings(entry) {
    return { profileId: entry.profileId, bookmarks: entry.bookmarks || [], bookmarkBarVisible: entry.bookmarkBarVisible !== false,
      zoomLevel: entry.zoomLevel || 0, extensions: (entry.extensionList || []).filter((item) => item.url).map((item) => ({ id: item.id, pinned: item.pinned === true, url: item.url })),
      activeProxyId: entry.activeProxyId || null, proxyFailover: entry.proxyFailover === true,
      revision: entry.settingsRevision || 0 };
  }

  function notifyBrowserSettings(entry) {
    if (entry.applyingSettings || entry.state !== "running") return;
    options.onBrowserSettingsChanged?.(browserSettings(entry));
  }

  async function reloadExtensionList(entry) {
    if (!extensionStore) return;
    const all = await extensionStore.list().catch(() => []);
    entry.extensionList = all
      .filter((item) => !entry.extensionsLoaded || entry.extensionsLoaded.has(item.id))
      .map((item) => ({ id: item.id, name: item.name, version: item.version, enabled: item.enabled !== false, icon: item.icon || "", pinned: item.pinned === true, ...(item.url ? { url: item.url } : {}) }));
  }
  function checkConnection(entry) {
    if (entry.checkJob) return entry.checkJob;
    if (!entry.proxyTarget || !options.checkProxy || entry.state !== "running") return Promise.resolve();
    const job = Promise.resolve().then(() => options.checkProxy(entry.proxyTarget)).then((result) => {
      entry.connection = result; entry.checkedAt = new Date().toISOString();
      if (!result?.ok) void failoverProxy(entry).catch(() => {});
    }).catch(() => { entry.connection = { ok: false }; void failoverProxy(entry).catch(() => {}); }).finally(() => {
      entry.checkJob = null; entry.browser?.publish?.();
    });
    entry.checkJob = job;
    entry.browser?.publish?.();
    return job;
  }

  // Новая вкладка открывается сразу: загрузка страницы продолжается в фоне и
  // больше не задерживает очередь команд окна профиля.
  async function makeWindow(entry, url, primary = false, loadOptions = {}, defer = !primary) {
    if (entry.closingRequested) throw new Error("Профиль закрывается");
    entry.browserPromise ||= createBrowser(electron, browserOptions(entry));
    entry.browser = await entry.browserPromise;
    entry.primary = entry.browser.shell;
    if (entry.closingRequested) throw new Error("Профиль закрывается");
    const win = entry.browser.createTab();
    entry.windows.add(win);
    win.on("close", (event) => {
      event.preventDefault();
      if (entry.windows.size === 1) {
        closeProfileWindow(entry.profileId).catch(() => { entry.lastError = "Profile close failed; local data retained"; });
      } else if (!entry.closingRequested) {
        snapshot(entry).then(() => { if (!win.isDestroyed()) win.destroy(); }).catch(() => { entry.lastError = "Popup cookie flush failed"; });
      }
    });
    win.on("closed", () => {
      entry.windows.delete(win);
      if (!entry.closingRequested) recordTabs(entry);
      if (!entry.windows.size && entry.state === "running" && !entry.closingRequested) {
        closeProfileWindow(entry.profileId).catch(() => { entry.lastError = "Profile close failed; local data retained"; });
      }
    });
    win.webContents.on("did-navigate", () => recordTabs(entry));
    win.webContents.on("did-navigate-in-page", () => recordTabs(entry));
    win.webContents.on("will-navigate", (event, target) => {
      try { startUrl(typeof target === "string" ? target : target.url, { allowBlank: true }); }
      catch { event.preventDefault(); }
    });
    win.webContents.on("will-redirect", (event, target) => {
      try { startUrl(typeof target === "string" ? target : target.url, { allowBlank: true }); }
      catch { event.preventDefault(); }
    });
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler((details) => {
      if (entry.closingRequested) return { action: "deny" };
      let target;
      try { target = startUrl(details.url, { allowBlank: true }); }
      catch { entry.lastError = "Unsupported popup URL blocked"; return { action: "deny" }; }
      // Native window.open begins navigation before async CDP setup can finish.
      // Managed popups deliberately have no opener; form posts are not replayed.
      if (details.postBody) { entry.lastError = "Popup form POST unsupported"; return { action: "deny" }; }
      const pending = makeWindow(entry, target).catch(() => { entry.lastError = "Popup launch failed"; }).finally(() => entry.pendingWindows.delete(pending));
      entry.pendingWindows.add(pending);
      return { action: "deny" };
    });
    try {
      // Start a renderer on an inert document before awaiting its CDP commands.
      // No remote page can execute until all fingerprint commands have completed.
      await navigate(win, "about:blank");
      entry.fingerprintDiagnostics = await configureFingerprint(win.webContents, entry.fp);
      win.webContents.debugger.on("detach", () => {
        if (entry.closingRequested || win.closing || win.isDestroyed()) return;
        entry.lastError = "Fingerprint debugger detached; profile stopped";
        blockSession(entry.ses);
        closeProfileWindow(entry.profileId).catch(() => {});
      });
      if (entry.closingRequested) throw new Error("Profile is closing");
      if (options.show !== false) win.show();
      if (url !== "about:blank") {
        if (defer) void navigate(win, url, loadOptions).catch(() => { entry.lastError = "Profile navigation failed"; });
        else await navigate(win, url, loadOptions);
      }
      if (entry.closingRequested) throw new Error("Profile is closing");
      if (options.show !== false) win.show();
      return win;
    } catch (error) {
      if (!primary) entry.lastError = /^(Profile navigation failed|Unable to apply fingerprint before navigation)/.test(error.message) ? error.message : "Tab launch failed";
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  function launchProfileWindow(payload, onClosed) {
    const id = profileId(payload?.profileId);
    if (shuttingDown) return Promise.reject(new Error("Приложение завершает работу"));
    const existing = profiles.get(id);
    if (existing) {
      if (existing.closingRequested) return Promise.reject(new Error("Профиль закрывается"));
      if (existing.primary && !existing.primary.isDestroyed()) existing.primary.focus();
      return existing.startPromise;
    }
    const url = startUrl(payload.startUrl ?? payload.fingerprint?.startUrl ?? payload.fingerprint?.start_url ?? "about:blank", { allowBlank: true });
    const hasExplicitStartUrl = payload.startUrl != null;
    revision(payload.cookiesUpdatedAt);
    if (payload.lockToken != null && (typeof payload.lockToken !== "string" || payload.lockToken.length > 512)) throw new Error("Некорректный токен блокировки профиля");
    if (payload.deviceId != null && (typeof payload.deviceId !== "string" || !payload.deviceId || payload.deviceId.length > 512 || /[\r\n\0]/.test(payload.deviceId))) throw new Error("Некорректный идентификатор устройства");
    const entry = {
      profileId: id, name: typeof payload.name === "string" ? payload.name.slice(0, 200) : "Profile",
      lockToken: payload.lockToken ?? null, deviceId: payload.deviceId ?? null, partition: `persist:profile-${id}`,
      state: "starting", startedAt: new Date().toISOString(), windows: new Set(), pendingWindows: new Set(),
      snapshotQueue: Promise.resolve(), onClosed, closingRequested: false,
    };
    const initialSettings = sanitizeBrowserSettings(payload.browserSettings, id);
    const bookmarkDefaults = payload.bookmarkDefaults && typeof payload.bookmarkDefaults === "object" ? payload.bookmarkDefaults : null;
    entry.presetBookmarks = sanitizeBookmarks(bookmarkDefaults?.bookmarks);
    entry.teamId = bookmarkDefaults?.teamId;
    entry.presetBookmarkBarVisible = bookmarkDefaults?.bookmarkBarVisible !== false;
    entry.zoomLevel = initialSettings?.zoomLevel || 0;
    entry.settingsRevision = initialSettings?.revision || 0;
    profiles.set(id, entry);
    entry.startPromise = Promise.resolve().then(async () => {
      try {
        entry.ses = session.fromPartition(entry.partition);
        blockSession(entry.ses);
        const extensionApi = entry.ses.extensions || entry.ses;
        for (const extension of extensionApi.getAllExtensions?.() || []) extensionApi.removeExtension(extension.id);
        const defaultUA = entry.ses.getUserAgent().replace(/\s(?:Electron|Umbra)\/[^ ]+/g, "");
        entry.fp = normalizeFingerprint(payload.fingerprint || {}, defaultUA);
        // Warm the browser chrome while the authenticated proxy and cookies are
        // being prepared. Fingerprint application still completes before any
        // remote page is allowed to navigate.
        entry.browserPromise = createBrowser(electron, browserOptions(entry));
        void entry.browserPromise.catch(() => {});
        entry.proxyPool = sanitizeProxyPool(payload.proxies);
        entry.proxyFailover = initialSettings?.proxyFailover === true;
        const selected = initialSettings?.activeProxyId ? entry.proxyPool.find((item) => item.id === initialSettings.activeProxyId) : null;
        let launchProxy = selected ? proxyConnectionOf(selected) : payload.proxy;
        try {
          entry.proxyRuntime = await setupProxy(entry.ses, launchProxy);
        } catch (proxyFailure) {
          if (!selected) throw proxyFailure;
          launchProxy = payload.proxy;
          entry.proxyRuntime = await setupProxy(entry.ses, launchProxy);
        }
        entry.proxyTarget = launchProxy;
        entry.activeProxyId = matchPoolId(entry, launchProxy);
        entry.proxyLabel = proxyLabel(launchProxy);
        if (launchProxy) {
          entry.webrtcPolicy = SAFE_WEBRTC;
          try { entry.ses.setWebRTCIPHandlingPolicy?.(SAFE_WEBRTC); } catch { /* политика недоступна в этой сборке */ }
        }
        entry.ses.setUserAgent(entry.fp.userAgent, entry.fp.languages.join(","));
        // Background permission requests cannot enable arbitrary device access.
        entry.ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        entry.ses.setPermissionCheckHandler(() => false);
        const initialized = await initializeCookies(entry.ses, cookieStore(), { ...payload, profileId: id });
        entry.cookiesUpdatedAt = initialized.cookiesUpdatedAt;
        entry.cookieSignature = initialized.signature;
        entry.cookieSource = initialized.source;
        entry.extensionsLoaded = new Map();
        if (extensionStore) {
          if (initialSettings && extensionStore.applyCloudSettings) await extensionStore.applyCloudSettings(initialSettings.extensions);
          const extensionResult = await extensionStore.loadIntoSession(entry.ses, entry.extensionsLoaded);
          entry.extensionErrors = extensionResult.errors;
          await reloadExtensionList(entry);
        }
        const bookmarkState = initialSettings || await (bookmarkStore().readState?.(id) || bookmarkStore().read(id).then((bookmarks) => ({ bookmarks, barVisible: true, stored: true }))).catch(() => ({ bookmarks: [], barVisible: true, stored: true }));
        entry.bookmarks = bookmarkState.bookmarks;
        entry.bookmarkBarVisible = entry.presetBookmarks.length && entry.presetBookmarkBarVisible
          ? true
          : (initialSettings ? initialSettings.bookmarkBarVisible : (bookmarkState.bookmarks.length ? true : bookmarkState.barVisible));
        if (initialSettings) await bookmarkStore().write(id, { bookmarks: entry.bookmarks, barVisible: entry.bookmarkBarVisible });
        // Новый профиль получает стартовый набор рабочих закладок один раз.
        if (!initialSettings && !entry.presetBookmarks.length && !bookmarkState.stored && !bookmarkState.bookmarks.length) {
          entry.bookmarks = defaultBookmarks();
          void saveBookmarks(entry, entry.bookmarks);
        }
      const saved = await tabStore().read(id).catch(() => ({ tabs: [], activeIndex: 0 }));
      const restoreSaved = saved.tabs.length > 0 && !hasExplicitStartUrl;
      const plan = restoreSaved ? saved.tabs : [url];
      await makeWindow(entry, plan[0], true);
      for (const extra of plan.slice(1)) await makeWindow(entry, extra).catch(() => {});
      const restoredTabs = [...entry.windows];
      const focusTab = restoredTabs[restoreSaved ? Math.min(saved.activeIndex, restoredTabs.length - 1) : 0];
      if (focusTab && !focusTab.isDestroyed()) focusTab.show?.();
        entry.browser?.markReady?.();
        entry.state = "running";
        watchCookies(entry);
        entry.browser?.publish?.();
        notifyBrowserSettings(entry);
        void checkConnection(entry);
        return status(entry);
      } catch (error) {
        entry.state = "failed";
        unwatchCookies(entry);
        for (const win of entry.windows) if (!win.isDestroyed()) win.destroy();
        const warmedBrowser = await entry.browserPromise?.catch(() => null);
        entry.browser?.destroy();
        if (warmedBrowser && warmedBrowser !== entry.browser) warmedBrowser.destroy();
        if (entry.ses) blockSession(entry.ses);
        if (entry.proxyRuntime) await entry.proxyRuntime.dispose().catch(() => {});
        if (!entry.closingRequested) profiles.delete(id);
        // Errors from Electron can include navigation URLs and cookie values.
        const allowed = /^(Invalid|Only HTTP|Unable to (?:apply fingerprint|restore profile cookies|read encrypted|decrypt cookie|save encrypted)|OS cookie|Proxy setup|Profile (?:navigation|is closing))/;
        throw new Error(allowed.test(error.message) ? error.message : "Profile launch failed");
      }
    });
    return entry.startPromise;
  }

  async function snapshotProfileCookies(id) {
    const entry = profiles.get(profileId(id));
    if (!entry) return null;
    await entry.startPromise;
    return snapshot(entry);
  }

  function closeProfileWindow(id) {
    const entry = profiles.get(profileId(id));
    if (!entry) return Promise.resolve(null);
    if (entry.closePromise) return entry.closePromise;
    entry.closingRequested = true;
    entry.closePromise = (async () => {
      await entry.startPromise.catch(() => {});
      entry.state = "closing";
      unwatchCookies(entry);
      if (entry.ses) {
        blockSession(entry.ses);
        for (const win of entry.windows) if (!win.isDestroyed()) win.webContents.stop();
        await entry.ses.closeAllConnections();
      }
      await Promise.allSettled([...entry.pendingWindows]);
      // Freeze page JS before taking the final snapshot/outbox record.
      for (const win of entry.windows) {
        if (!win.isDestroyed() && win.webContents.debugger.isAttached()) await win.webContents.debugger.sendCommand("Emulation.setScriptExecutionDisabled", { value: true });
      }
      await persistTabs(entry).catch(() => {});
      const result = entry.cookiesUpdatedAt ? await snapshot(entry) : { profileId: entry.profileId, lockToken: entry.lockToken, deviceId: entry.deviceId, cookies: null, cookiesUpdatedAt: null };
      if (typeof entry.onClosed === "function") await entry.onClosed(result);
      const extensionApi = entry.ses?.extensions || entry.ses;
      for (const extensionId of entry.extensionsLoaded?.values() || []) extensionApi?.removeExtension?.(extensionId);
      if (entry.proxyRuntime) await entry.proxyRuntime.dispose();
      for (const win of entry.windows) if (!win.isDestroyed()) win.destroy();
      entry.browser?.destroy();
      profiles.delete(entry.profileId);
      return result;
    })().catch(() => {
      entry.state = "error";
      entry.lastError = "Profile close failed; retry required";
      entry.closePromise = null;
      throw new Error(entry.lastError);
    });
    return entry.closePromise;
  }

  async function closeAllProfiles() {
    shuttingDown = true;
    try {
      const results = await Promise.allSettled([...profiles.keys()].map(closeProfileWindow));
      if (results.some((result) => result.status === "rejected")) throw new Error("Some profiles could not be flushed; retry shutdown");
    } finally { shuttingDown = false; }
  }

  async function refreshExtensions() {
    if (!extensionStore) return 0;
    const failures = await Promise.all([...profiles.values()].map(async (entry) => {
      await entry.startPromise.catch(() => {});
      if (!entry.ses || entry.state !== "running" || entry.closingRequested) return 0;
      entry.extensionsLoaded ||= new Map();
      const extensionResult = await extensionStore.loadIntoSession(entry.ses, entry.extensionsLoaded);
      entry.extensionErrors = extensionResult.errors;
      await reloadExtensionList(entry);
      entry.browser?.publish?.();
      notifyBrowserSettings(entry);
      return extensionResult.errors.length;
    }));
    return failures.reduce((total, count) => total + count, 0);
  }

  async function applyBrowserSettings(value) {
    const id = profileId(value?.profileId);
    const entry = profiles.get(id);
    if (!entry) return false;
    await entry.startPromise;
    const settings = sanitizeBrowserSettings(value, id);
    if (!settings || settings.revision <= (entry.settingsRevision || 0)) return false;
    entry.applyingSettings = true;
    try {
      entry.settingsRevision = settings.revision; entry.zoomLevel = settings.zoomLevel;
      entry.bookmarks = settings.bookmarks; entry.bookmarkBarVisible = settings.bookmarkBarVisible;
      await bookmarkStore().write(id, { bookmarks: settings.bookmarks, barVisible: settings.bookmarkBarVisible });
      if (extensionStore?.applyCloudSettings) {
        await extensionStore.applyCloudSettings(settings.extensions);
        await reloadExtensionList(entry);
      }
      entry.proxyFailover = settings.proxyFailover === true;
      if (settings.activeProxyId && settings.activeProxyId !== entry.activeProxyId
        && (entry.proxyPool || []).some((item) => item.id === settings.activeProxyId)) {
        await switchProxy(entry, settings.activeProxyId).catch(() => {});
      }
      for (const tab of entry.windows) if (!tab.isDestroyed()) tab.webContents.setZoomLevel(settings.zoomLevel);
      entry.browser?.publish?.();
      return true;
    } finally { entry.applyingSettings = false; }
  }

  return {
    launchProfileWindow, closeProfileWindow, snapshotProfileCookies, closeAllProfiles,
    refreshExtensions, applyBrowserSettings,
    applyBookmarkDefaults: async (value) => {
      if (!value || typeof value.teamId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.teamId)) return false;
      const bookmarks = sanitizeBookmarks(value.bookmarks);
      for (const entry of profiles.values()) {
        if (entry.teamId !== value.teamId) continue;
        await entry.startPromise.catch(() => {});
        if (entry.state !== "running") continue;
        entry.presetBookmarks = bookmarks;
        entry.presetBookmarkBarVisible = value.bookmarkBarVisible !== false;
        if (bookmarks.length && entry.presetBookmarkBarVisible) entry.bookmarkBarVisible = true;
        entry.browser?.publish?.();
      }
      return true;
    },
    listRunningProfiles: () => [...profiles.values()].map(status),
    getRunningProfile: (id) => { const entry = profiles.get(profileId(id)); return entry ? status(entry) : null; },
  };
}

module.exports = { createProfileRuntime };
