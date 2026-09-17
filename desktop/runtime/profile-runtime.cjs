const { profileId, startUrl, revision } = require("./validation.cjs");
const { createProfileBrowser } = require("./browser.cjs");
const { createRuntimeProxy, blockSession } = require("./proxy.cjs");
const { createCookieStore, initializeCookies, canonicalCookies } = require("./cookies.cjs");
const { createTabStore, sanitizeTabs } = require("./tabs.cjs");
const { normalizeFingerprint, applyFingerprint } = require("./fingerprint.cjs");

function createProfileRuntime(electron, options = {}) {
  const { session, app, safeStorage } = electron;
  const createBrowser = options.createBrowser || createProfileBrowser;
  const setupProxy = options.setupProxy || createRuntimeProxy;
  const configureFingerprint = options.applyFingerprint || applyFingerprint;
  const profiles = new Map();
  let shuttingDown = false;
  let store;
  let tabs;
  const cookieStore = () => store ||= options.cookieStore || createCookieStore({ safeStorage, userData: app.getPath("userData") });
  const tabStore = () => tabs ||= options.tabStore || createTabStore({ safeStorage, userData: app.getPath("userData") });
  const extensionStore = options.extensionStore;

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
    const tabs = openTabUrls(entry);
    if (!tabs.length) return Promise.resolve();
    entry.tabQueue = (entry.tabQueue || Promise.resolve())
      .catch(() => {})
      .then(() => tabStore().write(entry.profileId, tabs, 0))
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
    };
  }
  function checkConnection(entry) {
    if (entry.checkJob) return entry.checkJob;
    if (!entry.proxyTarget || !options.checkProxy || entry.state !== "running") return Promise.resolve();
    const job = Promise.resolve().then(() => options.checkProxy(entry.proxyTarget)).then((result) => {
      entry.connection = result; entry.checkedAt = new Date().toISOString();
    }).catch(() => { entry.connection = { ok: false }; }).finally(() => {
      entry.checkJob = null; entry.browser?.publish?.();
    });
    entry.checkJob = job;
    entry.browser?.publish?.();
    return job;
  }

  async function makeWindow(entry, url, primary = false, loadOptions = {}) {
    if (entry.closingRequested) throw new Error("Profile is closing");
    entry.browserPromise ||= createBrowser(electron, browserOptions(entry));
    entry.browser = await entry.browserPromise;
    entry.primary = entry.browser.shell;
    if (entry.closingRequested) throw new Error("Profile is closing");
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
      if (url !== "about:blank") await navigate(win, url, loadOptions);
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
    if (shuttingDown) return Promise.reject(new Error("Application is shutting down"));
    const existing = profiles.get(id);
    if (existing) {
      if (existing.closingRequested) return Promise.reject(new Error("Profile is closing"));
      if (existing.primary && !existing.primary.isDestroyed()) existing.primary.focus();
      return existing.startPromise;
    }
    const url = startUrl(payload.startUrl ?? payload.fingerprint?.startUrl ?? payload.fingerprint?.start_url ?? "about:blank", { allowBlank: true });
    revision(payload.cookiesUpdatedAt);
    if (payload.lockToken != null && (typeof payload.lockToken !== "string" || payload.lockToken.length > 512)) throw new Error("Invalid profile lock token");
    if (payload.deviceId != null && (typeof payload.deviceId !== "string" || !payload.deviceId || payload.deviceId.length > 512 || /[\r\n\0]/.test(payload.deviceId))) throw new Error("Invalid device ID");
    const entry = {
      profileId: id, name: typeof payload.name === "string" ? payload.name.slice(0, 200) : "Profile",
      lockToken: payload.lockToken ?? null, deviceId: payload.deviceId ?? null, partition: `persist:profile-${id}`,
      state: "starting", startedAt: new Date().toISOString(), windows: new Set(), pendingWindows: new Set(),
      snapshotQueue: Promise.resolve(), onClosed, closingRequested: false,
    };
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
        entry.proxyRuntime = await setupProxy(entry.ses, payload.proxy);
        entry.proxyTarget = payload.proxy;
        entry.proxyLabel = payload.proxy ? String(payload.proxy.protocol).toUpperCase() + " · " + payload.proxy.host + ":" + payload.proxy.port : "Без прокси";
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
        const extensionResult = await extensionStore.loadIntoSession(entry.ses, entry.extensionsLoaded);
        entry.extensionErrors = extensionResult.errors;
      }
      const saved = await tabStore().read(id).catch(() => ({ tabs: [], activeIndex: 0 }));
      const plan = url !== "about:blank" ? [url] : (saved.tabs.length ? saved.tabs : ["about:blank"]);
      await makeWindow(entry, plan[0], true);
      for (const extra of plan.slice(1)) await makeWindow(entry, extra).catch(() => {});
      const restoredTabs = [...entry.windows];
      const focusTab = restoredTabs[url !== "about:blank" ? 0 : Math.min(saved.activeIndex, restoredTabs.length - 1)];
      if (focusTab && !focusTab.isDestroyed()) focusTab.show?.();
        entry.state = "running";
        watchCookies(entry);
        entry.browser?.publish?.();
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
      entry.browser?.publish?.();
      return extensionResult.errors.length;
    }));
    return failures.reduce((total, count) => total + count, 0);
  }

  return {
    launchProfileWindow, closeProfileWindow, snapshotProfileCookies, closeAllProfiles,
    refreshExtensions,
    listRunningProfiles: () => [...profiles.values()].map(status),
    getRunningProfile: (id) => { const entry = profiles.get(profileId(id)); return entry ? status(entry) : null; },
  };
}

module.exports = { createProfileRuntime };
