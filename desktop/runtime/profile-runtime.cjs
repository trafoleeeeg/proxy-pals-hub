const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { profileId, startUrl, revision } = require("./validation.cjs");
const { createProfileBrowser } = require("./browser.cjs");
const { createRuntimeProxy, blockSession } = require("./proxy.cjs");
const { createCookieStore, initializeCookies, canonicalCookies, parseCookies, parseCookieImport, applyImportedCookies, registerCookieTransport, readSessionCookies, disposeCookieTransport } = require("./cookies.cjs");
const { cookieHash, saveProof, saveAttempts } = require("./cookie-save-journal.cjs");
const { createCookieTransport } = require("./cookie-transport.cjs");
const { createTabStore, sanitizeTabs } = require("./tabs.cjs");
const { createBookmarkStore, defaultBookmarks, sanitizeBookmarks } = require("./bookmarks.cjs");
const { normalizeFingerprint, applyNativeScreenMetrics, applyNativeHardwareMetrics, applyFingerprint, installSessionPrivacy } = require("./fingerprint.cjs");
const { createPrivacyStore, privacyOrigin } = require("./privacy-policy.cjs");
const { sanitizeBrowserSettings } = require("./browser-settings.cjs");
const { SAFE_WEBRTC } = require("./leak-check.cjs");
const { createFaviconLoader } = require("./favicons.cjs");
const { protectBackgroundWorkers, quarantineBackgroundWorkers, backgroundWorkerSessionSafe, cookieProtocolForSession } = require("./background-workers.cjs");
const { applyFontIsolation } = require("./font-isolation.cjs");
const { recordProcessEvent } = require("./process-diagnostics.cjs");
const { createCookieRecovery, recoveryRequest } = require("./cookie-recovery.cjs");

// Сообщения об ошибках запуска показываются пользователю, поэтому они переводятся
// на русский язык на границе клиента, без утечки URL и значений cookies.
const LAUNCH_ERROR_TEXT = [
  [/^Font isolation requires/i, "Для изоляции шрифтов нужен обновлённый движок Umbra; профиль не запущен"],
  [/^Font isolation bundle/i, "Комплект изолированных шрифтов отсутствует или повреждён; профиль не запущен"],
  [/^Font isolation/i, "Не удалось применить изоляцию шрифтов. После изменения режима перезапустите Umbra"],
  [/^Unable to restore imported cookies/i, "Ни один сохранённый cookie не удалось установить: проверьте срок действия и формат импорта. Облачные данные сохранены"],
  [/^Unable to (?:restore|read encrypted|decrypt) cookie/i, "Не удалось восстановить cookies профиля"],
  [/^Unable to save encrypted/i, "Не удалось сохранить cookies профиля"],
  [/^Unable to flush encrypted/i, "Не удалось сохранить cookies профиля"],
  [/^Unclean cookie recovery conflict/i, "После аварийного завершения остались локальные cookies, отличающиеся от облачной версии. Обе версии сохранены; требуется согласование данных"],
  [/^Unable to apply fingerprint/i, "Не удалось применить отпечаток браузера"],
  [/^Native screen protection is unavailable/i, "В сборке браузера нет нативной защиты экрана; профиль не запущен"],
  [/^Native screen protection could not be applied/i, "Не удалось применить защиту экрана. После изменения размеров перезапустите Umbra"],
  [/^Native hardware reporting protection is unavailable/i, "В сборке браузера нет нативной настройки CPU и памяти; обновите Umbra"],
  [/^Native hardware reporting could not be applied/i, "Не удалось применить CPU и память профиля. После изменения этих параметров перезапустите Umbra"],
  [/^OS cookie encryption/i, "Шифрование Windows недоступно, профиль не запущен"],
  [/^Proxy setup/i, "Не удалось поднять прокси, трафик заблокирован"],
  [/^Profile is closing/i, "Профиль закрывается, повторите запуск"],
  [/^Background worker shutdown failed/i, "Защита фоновых процессов не завершилась. Перезапустите Umbra перед открытием профиля"],
  [/^Profile navigation/i, "Не удалось открыть стартовую страницу профиля"],
  [/^Only HTTP/i, "Допустимы только адреса http(s) без логина и пароля"],
  [/^Invalid cookie/i, "Сохранённые cookies повреждены"],
  [/^Invalid fingerprint|^Invalid user agent/i, "Некорректные настройки отпечатка профиля"],
  [/^Invalid proxy|^Unsupported proxy|^SOCKS5/i, "Некорректные параметры прокси"],
  [/^Invalid start URL/i, "Некорректный стартовый адрес"],
  [/^Invalid/i, "Некорректные данные профиля"],
];

function launchErrorText(message) {
  for (const [pattern, text] of LAUNCH_ERROR_TEXT) if (pattern.test(message || "")) return text;
  return "Не удалось запустить профиль";
}

function within(promise, milliseconds) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Profile cleanup timed out")), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function createProfileRuntime(electron, options = {}) {
  const { session, app, safeStorage } = electron;
  const createBrowser = options.createBrowser || createProfileBrowser;
  const setupProxy = options.setupProxy || createRuntimeProxy;
  const configureFingerprint = options.applyFingerprint || applyFingerprint;
  const configureBackgroundWorkers = options.protectBackgroundWorkers || protectBackgroundWorkers;
  const cookieTransport = options.cookieTransport || (ses => createCookieTransport(cookieProtocolForSession(ses)));
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 4000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 15000;
  const profiles = new Map();
  let shuttingDown = false;
  let store;
  let recoveryRef;
  const cookieRecovery = () => recoveryRef ||= options.cookieRecovery || createCookieRecovery({ safeStorage, userData: app.getPath("userData") });
  let tabStoreRef;
  let bookmarkStoreRef;
  let privacyStoreRef;
  let extensionConsentRef;
  const extensionConsent = () => extensionConsentRef ||= options.extensionConsent || createPrivacyStore({ safeStorage, userData: app.getPath("userData"), extensions: true });
  const privacyStore = () => privacyStoreRef ||= options.privacyStore || createPrivacyStore({ safeStorage, userData: app.getPath("userData") });
  const cookieStore = () => store ||= options.cookieStore || createCookieStore({ safeStorage, userData: app.getPath("userData") });
  const tabStore = () => tabStoreRef ||= options.tabStore || createTabStore({ safeStorage, userData: app.getPath("userData") });
  const bookmarkStore = () => bookmarkStoreRef ||= options.bookmarkStore || createBookmarkStore({ safeStorage, userData: app.getPath("userData") });
  const extensionStore = options.extensionStore;
  const favicons = options.faviconLoader || (electron.net ? createFaviconLoader({ net: electron.net }, { cacheFile: path.join(app.getPath("userData"), "favicon-cache.json") }) : null);

  function status(entry) {
    return {
      profileId: entry.profileId, name: entry.name, lockToken: entry.lockToken, deviceId: entry.deviceId,
      state: entry.state, cookiesUpdatedAt: entry.cookiesUpdatedAt || null,
      windowCount: entry.browser && !entry.primary.isDestroyed() ? 1 : 0,
      tabCount: entry.windows.size, startedAt: entry.startedAt,
      ...(entry.recoveryBackupId ? { recoveryBackupId: entry.recoveryBackupId } : {}),
      diagnostics: {
        proxy: entry.proxyRuntime ? { ...entry.proxyRuntime.diagnostics } : { mode: "blocked" },
        fingerprint: entry.fingerprintDiagnostics || null,
        cookieSource: entry.cookieSource || null,
        cookieRestore: entry.cookieRestore || null,
        cookiePersistence: "safeStorage-encrypted-local-snapshot",
        extensions: { loaded: entry.extensionsLoaded?.size || 0, errors: entry.extensionErrors?.length || 0 },
        lastError: entry.lastError || null,
      },
    };
  }

  function snapshot(entry, issueAcknowledgement = false, durableSaveProtocol = false) {
    entry.snapshotQueue = entry.snapshotQueue.catch(() => {}).then(async () => {
      if (issueAcknowledgement && (profiles.get(entry.profileId) !== entry || entry.state !== "running" || entry.closingRequested)) return null;
      await entry.ses.cookies.flushStore();
      entry.ses.flushStorageData();
      const cookies = await readSessionCookies(entry.ses);
      const signature = canonicalCookies(cookies);
      if (signature !== entry.cookieSignature) {
        const next = new Date(Math.max(Date.now(), Date.parse(entry.cookiesUpdatedAt || 0) + 1)).toISOString();
        await cookieStore().write(entry.profileId, cookies, next, { pending: true, baseRevision: entry.cloudCookieRevision, saveAttempts: entry.saveAttempts });
        entry.cookiesUpdatedAt = next;
        entry.cookieSignature = signature;
      }
      const result = { profileId: entry.profileId, lockToken: entry.lockToken, deviceId: entry.deviceId, cookies: signature, cookiesUpdatedAt: entry.cookiesUpdatedAt };
      if (!issueAcknowledgement) return result;
      const snapshotId = randomUUID();
      const snapshotRevision = entry.cookiesUpdatedAt;
      const snapshotSequence = ++entry.cookieSnapshotSequence;
      const hash = cookieHash(cookies);
      const unchanged = hash === entry.cloudCookieHash;
      if (durableSaveProtocol && !unchanged) {
        // Never evict an unconfirmed save: it may be the only proof of a
        // committed reply lost during a long offline period.
        const repeated = entry.saveAttempts.find(item => item.cookieHash === hash && item.baseRevision === entry.cloudCookieRevision);
        if (repeated) return { ...result, snapshotId: repeated.saveId, snapshotRevision: repeated.snapshotRevision, snapshotSequence, baseRevision: entry.cloudCookieRevision, cookieHash: hash, unchanged };
        if (entry.saveAttempts.length >= 16) throw new Error("Cookie save journal awaiting server confirmation");
        const attempts = [...entry.saveAttempts, { saveId: snapshotId, snapshotRevision, cookieHash: hash, baseRevision: entry.cloudCookieRevision }];
        // Persist the identity BEFORE any caller can issue the network save.
        // Later local checkpoints retain it even if the reply/ACK is lost.
        await cookieStore().write(entry.profileId, cookies, snapshotRevision, { pending: true, baseRevision: entry.cloudCookieRevision, saveAttempts: attempts });
        entry.saveAttempts = attempts;
      }
      entry.issuedCookieSnapshots.set(snapshotId, { revision: snapshotRevision, sequence: snapshotSequence });
      // Only recent in-flight saves need receipts; repeated reads cannot grow
      // memory without bound. An expired receipt is rejected without mutation.
      if (entry.issuedCookieSnapshots.size > 16) entry.issuedCookieSnapshots.delete(entry.issuedCookieSnapshots.keys().next().value);
      return { ...result, snapshotId, snapshotRevision, snapshotSequence, baseRevision: entry.cloudCookieRevision, cookieHash: hash, unchanged };
    }).catch(() => { throw new Error("Unable to flush encrypted profile cookies"); });
    return entry.snapshotQueue;
  }

  function openTabUrls(entry) {
    const urls = [];
    for (const win of entry.windows) {
      if (win.isDestroyed() || win === entry.homeTab) continue;
      let current = "";
      try { current = win.webContents.getURL(); } catch { current = ""; }
      urls.push(current || win.url || "about:blank");
    }
    return sanitizeTabs(urls);
  }

  function persistTabs(entry) {
    const state = entry.browser?.getTabSnapshot?.();
    const tabs = state?.tabs || openTabUrls(entry);
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
      // Coalesce without postponing forever on a busy site's cookie stream.
      if (entry.cookieTimer) return;
      entry.cookieTimer = setTimeout(() => { entry.cookieTimer = null; checkpoint(); }, 300);
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
        cookies: entry.cookieRestore
          ? `Установлено ${entry.cookieRestore.installed} из ${entry.cookieRestore.total}` + (entry.cookieRestore.expired ? ` · истекли ${entry.cookieRestore.expired}` : "")
          : "Подготовка",
      }),
      checkConnection: () => checkConnection(entry),
      openTab: (target) => {
        const pending = makeWindow(entry, target).finally(() => entry.pendingWindows.delete(pending));
        entry.pendingWindows.add(pending);
        return pending;
      },
      closeProfile: () => closeProfileWindow(entry.profileId),
      importCookies: async (text) => {
        const cookies = parseCookieImport(text);
        const result = await applyImportedCookies(entry.ses, cookies);
        const saved = await snapshot(entry);
        entry.cookieRestore = { installed: result.imported, total: cookies.length, expired: cookies.filter((cookie) => cookie.expirationDate != null && cookie.expirationDate <= Date.now() / 1000).length };
        return { ...result, cookiesUpdatedAt: saved.cookiesUpdatedAt };
      },
      onTabsChanged: () => recordTabs(entry),
      getBookmarks: () => allBookmarks(entry),
      getBookmarkBarVisible: () => entry.bookmarkBarVisible !== false,
      getExtensions: () => entry.extensionList || [],
      setExtensionEnabled: async (id, enabled) => {
        if (!(entry.extensionList || []).some((item) => item.id === id)) throw new Error("Расширение не установлено на этом ПК");
        const ids = new Set(entry.allowedExtensions || []);
        if (enabled) ids.add(id); else ids.delete(id);
        await extensionConsent().write(entry.profileId, [...ids]);
        await closeProfileWindow(entry.profileId);
      },
      getZoomLevel: () => entry.zoomLevel || 0,
      getPrivacy: (url) => {
        const origin = privacyOrigin(url);
        if (entry.fp.aggressivePrivacyMode === false) {
          return { origin, mode: "normal", allowed: true, permissions: ["gpu", "canvas", "audio", "workers"] };
        }
        const permissions = (origin ? entry.fp.hardwarePermissions?.[origin] || [] : [])
          .filter((permission) => !entry.fp.fontIsolation || permission !== "fonts");
        return { origin, mode: "strict", allowed: permissions.length > 0, permissions };
      },
      setPrivacy: async (origin, permissions) => {
        if (entry.fp.fontIsolation && permissions.includes("fonts")) throw new Error("Изоляция шрифтов запрещает доступ к шрифтам ПК. Режим меняется в настройках профиля с перезапуском Umbra");
        if (entry.fp.aggressivePrivacyMode === false) throw new Error("В обычном режиме аппаратные API уже доступны. Режим меняется в настройках профиля");
        if (!origin || privacyOrigin(origin) !== origin) throw new Error("Откройте сайт для настройки защиты");
        const rules = { ...entry.fp.hardwarePermissions };
        if (permissions.length) rules[origin] = permissions;
        else delete rules[origin];
        await privacyStore().writePermissions(entry.profileId, rules);
        // Restart the entire profile: reload alone cannot revoke capabilities
        // already captured by shared workers, frames or another open tab.
        await closeProfileWindow(entry.profileId);
      },
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

  function reloadPagesAfterProxyChange(entry) {
    for (const win of entry.windows) {
      if (win.isDestroyed()) continue;
      let current = "";
      try { current = win.webContents.getURL?.() || win.url || ""; } catch { current = win.url || ""; }
      if (!current || current === "about:blank") continue;
      try {
        win.webContents.reload?.();
      } catch { entry.lastError = "Не удалось восстановить страницу после смены прокси"; }
    }
  }

  // Chromium can finish the main document even when a slow proxy has dropped
  // several image, stylesheet or font requests. In that case the page looks
  // "loaded", but remains full of empty placeholders until it is refreshed.
  // Retry the affected tab once the burst of transient failures has settled.
  function installResourceRecovery(entry) {
    const request = entry.ses?.webRequest;
    if (!request?.onErrorOccurred) return;
    const recoverable = new Set([
      "net::ERR_FAILED", "net::ERR_TIMED_OUT", "net::ERR_NETWORK_CHANGED",
      "net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_RESET",
      "net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_ABORTED",
      "net::ERR_NAME_NOT_RESOLVED", "net::ERR_INTERNET_DISCONNECTED",
      "net::ERR_CONNECTION_TIMED_OUT", "net::ERR_PROXY_CONNECTION_FAILED",
      "net::ERR_EMPTY_RESPONSE",
    ]);
    const resourceTypes = new Set(["image", "stylesheet", "font", "media", "script", "xhr"]);
    entry.resourceFailures = new Map();
    entry.resourceRecovery = new Map();
    request.onErrorOccurred({ urls: ["http://*/*", "https://*/*"] }, (details) => {
      if (entry.state === "closing" || entry.closingRequested || !resourceTypes.has(details.resourceType)
        || !recoverable.has(details.error)) return;
      const id = details.webContentsId;
      if (!Number.isInteger(id)) return;
      const now = Date.now();
      const previous = entry.resourceFailures.get(id);
      const failures = !previous || now - previous.startedAt > 5000
        ? { count: 1, startedAt: now }
        : { count: previous.count + 1, startedAt: previous.startedAt };
      entry.resourceFailures.set(id, failures);
      if (failures.count < 2 || entry.resourceRecovery.has(id)) return;
      const timer = setTimeout(() => {
        entry.resourceRecovery.delete(id);
        entry.resourceFailures.delete(id);
        const win = [...entry.windows].find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === id);
        if (!win) return;
        let current = "";
        try { current = win.webContents.getURL?.() || win.url || ""; } catch { current = win.url || ""; }
        if (!current || current === "about:blank") return;
        const last = entry.resourceReloads?.get(current) || 0;
        if (Date.now() - last < 60000) return;
        entry.resourceReloads ||= new Map();
        entry.resourceReloads.set(current, Date.now());
        try {
          win.webContents.reload?.();
        } catch { entry.lastError = "Не удалось восстановить изображения и стили страницы"; }
      }, 1200);
      timer.unref?.();
      entry.resourceRecovery.set(id, timer);
    });
  }

  function uninstallResourceRecovery(entry) {
    for (const timer of entry.resourceRecovery?.values() || []) clearTimeout(timer);
    entry.resourceRecovery?.clear();
    try { entry.ses?.webRequest?.onErrorOccurred?.(null); } catch { /* сессия уже закрывается */ }
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
      // Пока прокси переключается, fail-closed фильтр намеренно отменяет все
      // запросы. Перезагрузка нужна, чтобы страницы повторно запросили стили,
      // изображения и фоновые данные вместо оставшихся пустых блоков.
      reloadPagesAfterProxyChange(entry);
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
        reloadPagesAfterProxyChange(entry);
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
      loadBookmarkIcons(entry);
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
      zoomLevel: entry.zoomLevel || 0, extensions: (entry.extensionList || []).filter((item) => item.url && item.enabled).map((item) => ({ id: item.id, pinned: item.pinned === true, url: item.url })),
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
    // Незагруженные расширения остаются в списке с пометкой, иначе они молча исчезают.
    entry.extensionList = all.map((item) => {
      const runtimeId = entry.extensionsLoaded?.get(item.id) || "";
      const enabled = entry.allowedExtensions?.includes(item.id) === true;
      const failed = enabled && !!entry.extensionsLoaded && !entry.extensionsLoaded.has(item.id);
      return {
        id: item.id, name: item.name, version: item.version, enabled, failed, icon: item.icon || "",
        pinned: item.pinned === true, popup: item.popup || "", options: item.options || "", runtimeId,
        ...(item.url ? { url: item.url } : {}),
      };
    });
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
  async function makeWindow(entry, url, primary = false, loadOptions = {}, defer = !primary, activate = true) {
    if (entry.closingRequested) throw new Error("Профиль закрывается");
    entry.browserPromise ||= createBrowser(electron, browserOptions(entry));
    entry.browser = await entry.browserPromise;
    entry.primary = entry.browser.shell;
    if (entry.closingRequested) throw new Error("Профиль закрывается");
    const win = entry.browser.createTab({ pinnedHome: primary, activate });
    if (primary) entry.homeTab = win;
    entry.windows.add(win);
    win.on("close", (event) => {
      event.preventDefault();
      if (entry.windows.size === 1) {
        closeProfileWindow(entry.profileId).catch(() => { entry.lastError = "Profile close failed; local data retained"; });
      } else if (!entry.closingRequested) {
        if (!win.isDestroyed()) win.destroy();
        void snapshot(entry).catch(() => { entry.lastError = "Не удалось сохранить текущую сессию вкладки"; });
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
      // Отпечаток применяется к пустому рендереру до любой удалённой навигации.
      // Полная загрузка about:blank больше не ожидается: страница лишь
      // запускается без await, чтобы рендерер существовал для CDP. Если
      // отладчик недоступен, запуск отклоняется. Каждый CDP-запрос ограничен
      // таймаутом; второй контроллер поверх незавершённого не запускается.
      try {
        if (win.webContents.getURL() === "" && !win.webContents.isLoading()) {
          win.webContents.loadURL("about:blank").catch(() => {});
        }
      } catch { /* рендерер появится при первой навигации */ }
      const fingerprintOptions = { isClosing: () => entry.closingRequested || win.closing || win.isDestroyed(), onFailure: () => {
        if (entry.closingRequested || win.closing || win.isDestroyed()) return;
        entry.lastError = "Защита страницы недоступна, профиль остановлен";
        blockSession(entry.ses);
        void closeProfileWindow(entry.profileId).catch(() => {});
      } };
      entry.fingerprintDiagnostics = await configureFingerprint(win.webContents, entry.fp, fingerprintOptions);
      if (entry.closingRequested) throw new Error("Profile is closing");
      if (win.closing || win.isDestroyed()) return null;
      // configureFingerprint already fails closed when CDP unexpectedly
      // detaches from a live renderer. Do not add another unconditional
      // listener here: Electron also detaches with "target closed" after a
      // single tab renderer crashes or is deliberately closed. Treating that
      // normal target teardown as a profile-wide protection failure closed the
      // whole profile after an isolated tab crash.
      if (entry.closingRequested) throw new Error("Profile is closing");
      if (options.show !== false && activate) win.show();
      if (url !== "about:blank") {
        if (defer) void navigate(win, url, loadOptions).catch(() => { entry.lastError = "Не удалось открыть страницу"; });
        else await navigate(win, url, loadOptions);
      }
      if (entry.closingRequested) throw new Error("Profile is closing");
      return win;
    } catch (error) {
      // User cancellation of a newly created tab is not a launch/protection
      // failure and must not report an error against the shared profile.
      if (!primary && !entry.closingRequested && (win.closing || win.isDestroyed())) return null;
      if (!primary) entry.lastError = launchErrorText(error.message);
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  function launchProfileWindow(payload, onClosed) {
    const id = profileId(payload?.profileId);
    if (shuttingDown) return Promise.reject(new Error("Приложение завершает работу"));
    const existing = profiles.get(id);
    if (existing) {
      if (payload.cookieRecovery) return Promise.reject(new Error("Закройте профиль перед восстановлением cookies"));
      if (existing.closingRequested) return Promise.reject(new Error("Профиль закрывается"));
      if (existing.primary && !existing.primary.isDestroyed()) existing.primary.focus();
      return existing.startPromise;
    }
    const url = startUrl(payload.startUrl ?? payload.fingerprint?.startUrl ?? payload.fingerprint?.start_url ?? "about:blank", { allowBlank: true });
    const hasExplicitStartUrl = payload.startUrl != null;
    revision(payload.cookiesUpdatedAt);
    recoveryRequest(payload.cookieRecovery);
    if (payload.lockToken != null && (typeof payload.lockToken !== "string" || payload.lockToken.length > 512)) throw new Error("Некорректный токен блокировки профиля");
    if (payload.deviceId != null && (typeof payload.deviceId !== "string" || !payload.deviceId || payload.deviceId.length > 512 || /[\r\n\0]/.test(payload.deviceId))) throw new Error("Некорректный идентификатор устройства");
    const entry = {
      profileId: id, name: typeof payload.name === "string" ? payload.name.slice(0, 200) : "Profile",
      lockToken: payload.lockToken ?? null, deviceId: payload.deviceId ?? null, partition: `persist:profile-${id}`,
      state: "starting", startedAt: new Date().toISOString(), windows: new Set(), pendingWindows: new Set(),
      snapshotQueue: Promise.resolve(), onClosed, closingRequested: false,
      cloudCookieRevision: revision(payload.cookiesUpdatedAt),
      cloudCookieHash: cookieHash(parseCookies(payload.cookies ?? "[]")), saveAttempts: [],
      cookieSnapshotSequence: 0, acknowledgedCookieSequence: 0, issuedCookieSnapshots: new Map(),
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
        if (!backgroundWorkerSessionSafe(entry.ses)) throw new Error("Background worker shutdown failed; restart Umbra");
        // Install guards before opening the proxy gate: service workers from
        // an existing partition must never inherit default device permissions.
        const localFontsAllowed = (permission, url) => {
          if (permission !== "local-fonts" || entry.fp?.fontIsolation || entry.fp?.aggressivePrivacyMode === false) return false;
          const origin = privacyOrigin(url);
          return !!origin && entry.fp?.hardwarePermissions?.[origin]?.includes("fonts") === true;
        };
        entry.ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(localFontsAllowed(permission, details?.requestingUrl)));
        entry.ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => localFontsAllowed(permission, requestingOrigin));
        entry.ses.setDevicePermissionHandler(() => false);
        entry.ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
        const extensionApi = entry.ses.extensions || entry.ses;
        for (const extension of extensionApi.getAllExtensions?.() || []) extensionApi.removeExtension(extension.id);
        const defaultUA = entry.ses.getUserAgent().replace(/\s(?:Electron|Umbra)\/[^ ]+/g, "");
        entry.fp = normalizeFingerprint(payload.fingerprint || {}, defaultUA);
        await applyFontIsolation(entry.ses, entry.fp, { app });
        applyNativeScreenMetrics(entry.ses, entry.fp, {
          required: process.env.UMBRA_REQUIRE_NATIVE_SCREEN === "1" || (process.platform === "win32" && electron.app?.isPackaged === true),
        });
        applyNativeHardwareMetrics(entry.ses, entry.fp, {
          required: process.env.UMBRA_REQUIRE_NATIVE_HARDWARE === "1" || (process.platform === "win32" && electron.app?.isPackaged === true),
        });
        entry.fp.hardwarePermissions = await privacyStore().readPermissions(id);
        entry.backgroundWorkers = await configureBackgroundWorkers(entry.ses, entry.fp, {
          onDiagnostic: (details) => recordProcessEvent(app?.getPath?.("userData"), "background-worker", details),
          onFailure: (message) => {
          entry.lastError = message;
          blockSession(entry.ses);
          void closeProfileWindow(entry.profileId).then(
            () => app?.emit?.("umbra:profile-protection-failed", { saved: true }),
            () => app?.emit?.("umbra:profile-protection-failed", { saved: false }),
          );
        } });
        // Remove only background worker registrations before opening the network
        // gate. Old workers must not execute with a revoked/missing exception.
        // Cookies, localStorage, IndexedDB and cache storage remain intact.
        if (entry.fp.aggressivePrivacyMode && entry.ses.clearStorageData) await entry.ses.clearStorageData({ storages: ["serviceworkers"] });
        if (entry.ses.webRequest.onBeforeSendHeaders) installSessionPrivacy(entry.ses, entry.fp, () => entry.backgroundWorkers.isActive());
        entry.ses.setUserAgent(entry.fp.userAgent, entry.fp.languages.join(","));
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
          // A selected proxy must not fall back to direct internet when the
          // profile has no default proxy. Only another configured proxy is safe.
          if (!selected || !payload.proxy) throw proxyFailure;
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
         installResourceRecovery(entry);
        registerCookieTransport(entry.ses, cookieTransport(entry.ses));
        const initialized = await initializeCookies(entry.ses, cookieStore(), { ...payload, profileId: id }, cookieRecovery());
        entry.saveAttempts = initialized.saveAttempts;
        entry.cookiesUpdatedAt = initialized.cookiesUpdatedAt;
        entry.cookieSignature = initialized.signature;
        entry.cookieSource = initialized.source;
        entry.cookieRestore = initialized.cookieRestore;
        entry.recoveryBackupId = initialized.recoveryBackupId;
        entry.extensionsLoaded = new Map();
        entry.allowedExtensions = await extensionConsent().read(id);
        if (extensionStore) {
          if (initialSettings && extensionStore.applyCloudSettings) await extensionStore.applyCloudSettings(initialSettings.extensions);
          const extensionResult = await extensionStore.loadIntoSession(entry.ses, entry.extensionsLoaded, entry.allowedExtensions);
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
      const plan = restoreSaved ? saved.tabs : (url === "about:blank" ? [] : [url]);
      await makeWindow(entry, "about:blank", true);
      // Первую внешнюю страницу дожидаемся, как и раньше; остальные
      // восстанавливаются параллельно, без перестановки вкладок.
      if (plan.length) await makeWindow(entry, plan[0], false, {}, false, hasExplicitStartUrl);
      await Promise.all(plan.slice(1).map((extra) => makeWindow(entry, extra, false, {}, true, false).catch(() => {})));
      const focusTab = hasExplicitStartUrl && plan.length ? [...entry.windows][1] : entry.homeTab;
      if (focusTab && !focusTab.isDestroyed()) focusTab.show?.();
        entry.browser?.markReady?.();
        entry.state = "running";
        watchCookies(entry);
        entry.browser?.publish?.();
        notifyBrowserSettings(entry);
        void checkConnection(entry);
        loadBookmarkIcons(entry);
        return status(entry);
      } catch (error) {
        entry.state = "failed";
        unwatchCookies(entry);
         uninstallResourceRecovery(entry);
        for (const win of entry.windows) if (!win.isDestroyed()) win.destroy();
        const warmedBrowser = await entry.browserPromise?.catch(() => null);
        entry.browser?.destroy();
        if (warmedBrowser && warmedBrowser !== entry.browser) warmedBrowser.destroy();
        if (entry.ses) blockSession(entry.ses);
        await entry.backgroundWorkers?.stop().catch(() => {});
        if (entry.ses) disposeCookieTransport(entry.ses);
        if (entry.proxyRuntime) await entry.proxyRuntime.dispose().catch(() => {});
        if (!entry.closingRequested) profiles.delete(id);
        // Errors from Electron can include navigation URLs and cookie values.
        const failure = new Error(error.code === "COOKIE_RECOVERY_CONFLICT" && error.recovery?.changed
          ? "Версии cookies изменились. Проверьте новый выбор восстановления." : launchErrorText(error.message));
        if (error.code === "COOKIE_RECOVERY_CONFLICT") { failure.code = error.code; failure.recovery = error.recovery; }
        if (error.code === "COOKIE_RECOVERY_FAILED") failure.message = error.message;
        throw failure;
      }
    });
    return entry.startPromise;
  }

  async function snapshotProfileCookies(id, cookieSaveProtocol) {
    if (cookieSaveProtocol != null && cookieSaveProtocol !== 1) throw new Error("Invalid cookie save protocol");
    const entry = profiles.get(profileId(id));
    if (!entry) return null;
    await entry.startPromise;
    return snapshot(entry, true, cookieSaveProtocol === 1);
  }

  async function acknowledgeProfileCookies(payload) {
    const id = profileId(payload?.profileId);
    const snapshotId = profileId(payload?.snapshotId);
    const snapshotRevision = revision(payload?.snapshotRevision);
    const cloudRevision = revision(payload?.cloudRevision);
    if (!snapshotRevision || !cloudRevision || typeof payload?.lockToken !== "string" || !payload.lockToken) throw new Error("Invalid cookie acknowledgement");
    const entry = profiles.get(id);
    if (!entry) return false;
    const valid = () => profiles.get(id) === entry && entry.state === "running" && !entry.closingRequested && entry.lockToken === payload.lockToken;
    entry.snapshotQueue = entry.snapshotQueue.catch(() => {}).then(async () => {
      if (!valid()) return false;
      const issued = entry.issuedCookieSnapshots.get(snapshotId);
      if (!issued || issued.revision !== snapshotRevision || issued.sequence <= entry.acknowledgedCookieSequence) return false;
      if (entry.cloudCookieRevision && Date.parse(cloudRevision) < Date.parse(entry.cloudCookieRevision)) return false;
      const current = await cookieStore().read(id);
      if (!valid()) return false;
      if (!current?.pending || current.cookiesUpdatedAt !== entry.cookiesUpdatedAt || canonicalCookies(current.cookies) !== entry.cookieSignature) throw new Error("Cookie checkpoint changed before acknowledgement");
      // The saved snapshot may already have newer local descendants. Rebase
      // the current checkpoint without replacing its cookies or local revision.
      // Serializing with snapshot() also makes later changes use the new base.
      await cookieStore().write(id, current.cookies, current.cookiesUpdatedAt, { pending: true, baseRevision: cloudRevision });
      entry.saveAttempts = [];
      entry.cloudCookieRevision = cloudRevision;
      entry.acknowledgedCookieSequence = issued.sequence;
      for (const [key, receipt] of entry.issuedCookieSnapshots) if (receipt.sequence <= issued.sequence) entry.issuedCookieSnapshots.delete(key);
      return true;
    });
    return entry.snapshotQueue;
  }

  async function reconcileProfileCookieSave(payload) {
    const id = profileId(payload?.profileId), proof = saveProof(payload?.proof);
    if (!proof || typeof payload?.lockToken !== "string") throw new Error("Invalid cookie save proof");
    const entry = profiles.get(id);
    if (!entry) return false;
    const valid = () => profiles.get(id) === entry && entry.state === "running" && !entry.closingRequested && entry.lockToken === payload.lockToken;
    entry.snapshotQueue = entry.snapshotQueue.catch(() => {}).then(async () => {
      if (!valid()) return false;
      const current = await cookieStore().read(id);
      const candidate = saveAttempts(current?.saveAttempts).find(attempt => attempt.saveId === proof.saveId && attempt.cookieHash === proof.cookieHash && attempt.baseRevision === current?.baseRevision);
      if (!candidate || !current?.pending || !valid() || current.cookiesUpdatedAt !== entry.cookiesUpdatedAt || canonicalCookies(current.cookies) !== entry.cookieSignature) return false;
      if (entry.cloudCookieRevision && Date.parse(proof.cookiesUpdatedAt) < Date.parse(entry.cloudCookieRevision)) return false;
      // Only metadata changes: a newer local C is NEVER replaced by saved B.
      await cookieStore().write(id, current.cookies, current.cookiesUpdatedAt, { pending: true, baseRevision: proof.cookiesUpdatedAt, saveAttempts: [] });
      entry.cloudCookieRevision = proof.cookiesUpdatedAt;
      entry.cloudCookieHash = proof.cookieHash;
      entry.saveAttempts = [];
      entry.issuedCookieSnapshots.clear();
      return true;
    });
    return entry.snapshotQueue;
  }

  function closeProfileWindow(id) {
    const entry = profiles.get(profileId(id));
    if (!entry) return Promise.resolve(null);
    if (entry.closePromise) return entry.closePromise;
    entry.closingRequested = true;
    // The user's close action is immediate; durable cleanup continues behind
    // the hidden shell. Keep the entry/lock until it finishes, preventing reopen.
    try { entry.primary?.hide?.(); } catch { /* shell may already be destroyed */ }
    // Revocation must block immediately, even while an asynchronous launch or
    // durable cookie save is still in flight.
    if (entry.ses) blockSession(entry.ses);
    const closePhase = (phase) => recordProcessEvent(app?.getPath?.("userData"), "profile-close-phase", { phase });
    const requireRestart = () => {
      quarantineBackgroundWorkers(entry.ses);
      entry.restartRequired = true;
    };
    closePhase("begin");
    entry.closePromise = (async () => {
      await entry.startPromise.catch(() => {});
      try { entry.primary?.hide?.(); } catch { /* shell may already be destroyed */ }
      entry.state = "closing";
      unwatchCookies(entry);
       uninstallResourceRecovery(entry);
      if (entry.ses) {
        blockSession(entry.ses);
        const cleanup = async (operation, task, timeout) => {
          const started = Date.now();
          try { await within(Promise.resolve().then(task), timeout); }
          catch {
            recordProcessEvent(app?.getPath?.("userData"), "profile-cleanup-failed", { operation, elapsedMs: Date.now() - started });
            requireRestart();
          }
        };
        const workersStopped = cleanup("workers", () => entry.backgroundWorkers?.stop(), shutdownTimeoutMs);
        const connectionsClosed = cleanup("connections", () => entry.ses.closeAllConnections(), shutdownTimeoutMs);
        // Network remains blocked while cleanup runs. A timeout quarantines
        // this BrowserContext; it cannot be reopened in the same process.
        for (const win of entry.windows) {
          try { if (!win.isDestroyed()) win.webContents.stop(); } catch { /* crashed renderer */ }
        }
        await Promise.all([workersStopped, connectionsClosed]);
      }
      closePhase("workers");
      await Promise.allSettled([...entry.pendingWindows]);
      // Freeze page JS before taking the final snapshot/outbox record.
      // A crashed renderer can detach its debugger or leave a CDP command
      // unresolved. It must not prevent the durable cookie/tab snapshot.
      await within(Promise.allSettled([...entry.windows].map((win) => Promise.resolve().then(() =>
        !win.isDestroyed() && win.webContents.debugger.isAttached()
          ? win.webContents.debugger.sendCommand("Emulation.setScriptExecutionDisabled", { value: true })
          : undefined))), cleanupTimeoutMs).catch(() => {});
      await persistTabs(entry).catch(() => {});
      closePhase("tabs");
      const result = entry.cookiesUpdatedAt ? await snapshot(entry) : { profileId: entry.profileId, lockToken: entry.lockToken, deviceId: entry.deviceId, cookies: null, cookiesUpdatedAt: null };
      closePhase("cookies");
      if (typeof entry.onClosed === "function") await entry.onClosed(result);
      closePhase("outbox");
      const extensionApi = entry.ses?.extensions || entry.ses;
      for (const extensionId of entry.extensionsLoaded?.values() || []) {
        try { extensionApi?.removeExtension?.(extensionId); } catch { /* session is blocked and saved */ }
      }
      if (entry.proxyRuntime) {
        try { await within(Promise.resolve().then(() => entry.proxyRuntime.dispose()), cleanupTimeoutMs); }
        catch {
          recordProcessEvent(app?.getPath?.("userData"), "profile-cleanup-failed", { operation: "proxy" });
          requireRestart();
        }
      }
      if (entry.restartRequired) {
        try { app?.emit?.("umbra:profile-restart-required"); } catch { /* notification is optional */ }
      } else {
        // Clear crash recovery only after confirmed cleanup and durable outbox.
        await cookieStore().markClosed?.(entry.profileId);
      }
      for (const win of entry.windows) if (!win.isDestroyed()) win.destroy();
      entry.browser?.destroy();
      if (entry.ses) disposeCookieTransport(entry.ses);
      profiles.delete(entry.profileId);
      closePhase("done");
      return result;
    })().catch(() => {
      closePhase("failed");
      entry.state = "error";
      entry.lastError = "Не удалось закрыть профиль, повторите попытку";
      try { entry.primary?.show?.(); } catch { /* shell may already be destroyed */ }
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
      const extensionResult = await extensionStore.loadIntoSession(entry.ses, entry.extensionsLoaded, entry.allowedExtensions);
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
    launchProfileWindow, closeProfileWindow, snapshotProfileCookies, acknowledgeProfileCookies, reconcileProfileCookieSave, closeAllProfiles,
    listCookieRecoveryBackups: id => cookieRecovery().listBackups(profileId(id)),
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
