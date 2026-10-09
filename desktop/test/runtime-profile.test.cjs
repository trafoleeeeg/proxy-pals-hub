const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { createProfileRuntime } = require("../runtime/profile-runtime.cjs");
const { normalizeFingerprint, applyFingerprint, userAgentOverride } = require("../runtime/fingerprint.cjs");
const ID = "10000000-0000-4000-8000-000000000001";
const FP = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0", languages: ["de-DE", "de"], timezone: "Europe/Berlin", hardwareConcurrency: 6, screen: { width: 1920, height: 1080, colorDepth: 24 } };
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function harness({ diagnosticFailure = false } = {}) {
  const diagnosticEvents = [];
  const windows = [];
  const sessions = new Map();
  let configured = 0;
  let disposed = 0;
  let flushGate = null;
  let navigationGate = null;
  let snapshotFailure = false;
  let workerStop = async () => {};
  let freezeCommand = async () => {};
  let proxyDispose = async () => {};
  const records = new Map();
  const tabRecords = new Map();
  const bookmarkRecords = new Map();
  const privacyRecords = new Map();
  const storageClears = [];
  let browserConfig;
  const shell = { hidden: false, isDestroyed: () => false, focus() {}, hide() { this.hidden = true; }, show() { this.hidden = false; } };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        setUserAgent: (ua) => { this.ua = ua; },
        setWebRTCIPHandlingPolicy: (policy) => { this.policy = policy; },
        getWebRTCIPHandlingPolicy: () => this.policy,
        getURL: () => this.url || "", isLoading: () => false,
        loadURL: (url) => this.loadURL(url),
        setWindowOpenHandler: (handler) => { this.openHandler = handler; }, stop: () => {},
      });
      this.webContents.debugger = new EventEmitter();
      Object.assign(this.webContents.debugger, { attach: () => {}, isAttached: () => true, detach: () => {}, sendCommand: async (command, args) => {
        this.commands.push({ command, args });
        if (command === "Emulation.setScriptExecutionDisabled") await freezeCommand();
      } });
      this.commands = []; windows.push(this);
    }
    async loadURL(url) {
      if (url !== "about:blank") {
        assert.ok(this.commands.some((c) => c.command === "Emulation.setTimezoneOverride"));
        assert.ok(this.commands.some((c) => c.command === "Page.addScriptToEvaluateOnNewDocument"));
      }
      this.url = url;
      if (navigationGate && url !== "about:blank") await navigationGate.promise;
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown = true; }
    maximize() { this.maximized = true; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    close() { this.emit("close", { preventDefault() {} }); }
  }
  const electron = {
    BrowserWindow: Window,
    app: { getPath: () => "." },
    session: { fromPartition(partition) {
      if (sessions.has(partition)) return sessions.get(partition);
      const cookies = new EventEmitter();
      let data = [];
      Object.assign(cookies, { get: async () => data, set: async (cookie) => { data.push({ ...cookie, domain: cookie.domain || new URL(cookie.url).hostname, session: true, hostOnly: !cookie.domain }); }, flushStore: async () => { if (flushGate) await flushGate.promise; }, update: (value) => { data = value; cookies.emit("changed"); } });
      const ses = { cookies, webRequest: { onBeforeRequest() {} }, getUserAgent: () => "Chrome/144.0.0.0", setUserAgent() {}, flushStorageData() {}, closeAllConnections: async () => {}, clearStorageData: async (options) => { storageClears.push(options); if (!options?.storages || options.storages.includes("cookies")) data = []; },
        setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
        setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
        setDevicePermissionHandler(handler) { this.devicePermission = handler; },
        setDisplayMediaRequestHandler(handler) { this.displayMedia = handler; },
      };
      sessions.set(partition, ses); return ses;
    } },
  };
  const runtime = createProfileRuntime(electron, {
    recordDiagnostic: (_directory, event, details) => { if (diagnosticFailure) throw new Error("Disk unavailable"); diagnosticEvents.push({ event, ...details }); },
    cookieTransport: ses => ({ read: () => ses.cookies.get({}), write: cookie => ses.cookies.set({ ...cookie, url: "https://" + cookie.domain.replace(/^\./, "") }) }),
    cleanupTimeoutMs: 25,
    shutdownTimeoutMs: 100,
    protectBackgroundWorkers: async () => ({ stop: () => workerStop(), isActive: () => true }),
    createBrowser: async (_electron, options) => (browserConfig = options, {
      shell, destroy() {},
      createTab: () => new Window({ webPreferences: { partition: options.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } }),
    }),
    setupProxy: async (ses) => {
      assert.equal(ses.permissionCheck(), false, "permissions denied before opening network gate");
      assert.equal(ses.devicePermission(), false, "device access denied before opening network gate");
      configured++; return { diagnostics: { mode: "http" }, dispose: async () => { disposed++; await proxyDispose(); } };
    },
    cookieStore: {
      read: async (id) => records.get(id),
      write: async (id, cookies, cookiesUpdatedAt, recovery = {}) => { if (snapshotFailure) throw new Error("simulated disk failure"); records.set(id, { cookies, cookiesUpdatedAt, ...recovery }); },
      markClosed: async (id) => {
        if (snapshotFailure) throw new Error("simulated disk failure");
        const record = records.get(id);
        if (record?.pending) records.set(id, { cookies: record.cookies, cookiesUpdatedAt: record.cookiesUpdatedAt });
      },
    },
    tabStore: {
      read: async (id) => tabRecords.get(id) || { tabs: [], activeIndex: 0 },
      write: async (id, tabs, activeIndex) => { tabRecords.set(id, { tabs: [...tabs], activeIndex }); },
    },
    bookmarkStore: {
      readState: async (id) => bookmarkRecords.get(id) || { bookmarks: [], barVisible: true },
      write: async (id, state) => { bookmarkRecords.set(id, structuredClone(state)); return structuredClone(state); },
    },
    privacyStore: { readPermissions: async (id) => privacyRecords.get(id) || {}, writePermissions: async (id, rules) => { privacyRecords.set(id, structuredClone(rules)); } },
  });
  return { runtime, diagnosticEvents, electron, shell, privacyRecords, windows, sessions, records, tabRecords, bookmarkRecords, storageClears, get browserConfig() { return browserConfig; }, get configured() { return configured; }, get disposed() { return disposed; }, setFlushGate: (gate) => { flushGate = gate; }, setNavigationGate: (gate) => { navigationGate = gate; }, setSnapshotFailure: (value) => { snapshotFailure = value; }, setWorkerStop: (fn) => { workerStop = fn; }, setFreezeCommand: (fn) => { freezeCommand = fn; }, setProxyDispose: (fn) => { proxyDispose = fn; } };
}

const payload = () => ({ profileId: ID, deviceId: "test-device", name: "Test", lockToken: "test-lock-token", fingerprint: FP, cookies: "[]", cookiesUpdatedAt: null, proxy: null, startUrl: "https://example.test" });

test("lifecycle journal links launch, close initiator and durable cleanup for the same run", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload());
  await h.browserConfig.closeProfile("shell-close");
  const events = h.diagnosticEvents;
  const runId = events[0].runId;
  assert.ok(runId && runId !== ID);
  assert.ok(events.every(row => row.runId === runId));
  assert.deepEqual(events.filter(row => row.event === "profile-lifecycle").map(row => row.phase), ["starting", "session", "fingerprint", "workers", "proxy", "cookies", "extensions", "tabs", "tabs", "tabs", "running"]);
  assert.equal(events.find(row => row.event === "profile-close-request").source, "shell-close");
  assert.deepEqual(events.filter(row => row.event === "profile-close-phase").map(row => row.phase), ["begin", "workers", "tabs", "cookies", "outbox", "done"]);
  assert.ok(events.filter(row => row.event === "profile-close-phase").every(row => row.source === "shell-close" && row.elapsedMs >= 0));
  assert.equal(h.runtime.getRunningProfile(ID), null);
});

test("unwritable diagnostics cannot block launch, encrypted save or close", async () => {
  const h = harness({ diagnosticFailure: true });
  await h.runtime.launchProfileWindow(payload());
  await h.runtime.closeAllProfiles();
  assert.equal(h.records.has(ID), true);
  assert.equal(h.runtime.getRunningProfile(ID), null);
});

test("page protection failure saves the profile and reports why the window was closed", async () => {
  const h = harness();
  const notices = [];
  h.electron.app.emit = (event, details) => { if (event === "umbra:profile-protection-failed") notices.push(details); };
  await h.runtime.launchProfileWindow(payload());
  h.windows[0].webContents.debugger.emit("detach", {}, "replaced with devtools");
  await h.runtime.closeProfileWindow(ID);
  assert.deepEqual(notices, [{ saved: true, kind: "page" }]);
  assert.equal(h.records.has(ID), true, "durable cookie snapshot precedes the notification");
  assert.equal(h.runtime.getRunningProfile(ID), null);
});

test("native launch returns a metadata-only conflict and preserves the checkpoint before any page opens", async () => {
  const h = harness();
  const old = "2026-01-01T00:00:00.000Z", next = "2026-02-01T00:00:00.000Z";
  const local = { cookies: [{ name: "session", value: "synthetic-secret", domain: "example.test", path: "/", session: true }], cookiesUpdatedAt: next, pending: true, baseRevision: old };
  h.records.set(ID, local);
  let receipt;
  await assert.rejects(h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: next }), error => {
    receipt = error.recovery;
    return error.code === "COOKIE_RECOVERY_CONFLICT" && error.message.includes("согласование");
  });
  assert.equal(receipt.local.count, 1);
  assert.equal(receipt.cloud.count, 0);
  assert.equal(JSON.stringify(receipt).includes("synthetic-secret"), false);
  assert.equal(h.records.get(ID), local);
  assert.equal(h.runtime.getRunningProfile(ID), null);
  assert.equal(h.windows.length, 0);
  assert.equal(h.storageClears.some(clear => clear.storages.includes("cookies")), false);
});

test("isolated profile awaits fonts before network/windows and cannot grant host font access", async () => {
  const h = harness();
  const ses = h.electron.session.fromPartition(`persist:profile-${ID}`);
  const started = defer(), complete = defer();
  ses.setUmbraFontIsolation = async () => { started.resolve(); await complete.promise; };
  h.privacyRecords.set(ID, { "https://example.test": ["fonts", "workers"] });
  const launch = h.runtime.launchProfileWindow({ ...payload(), fingerprint: { ...FP, fontIsolation: true } });
  await started.promise;
  assert.equal(h.configured, 0);
  assert.equal(h.windows.length, 0);
  complete.resolve(); await launch;
  assert.equal(ses.permissionCheck(null, "local-fonts", "https://example.test"), false);
  let granted;
  ses.permissionRequest(null, "local-fonts", value => { granted = value; }, { requestingUrl: "https://example.test" });
  assert.equal(granted, false);
  assert.deepEqual(h.browserConfig.getPrivacy("https://example.test").permissions, ["workers"]);
  await assert.rejects(h.browserConfig.setPrivacy("https://example.test", ["fonts"]), /Изоляция шрифтов/);
  await h.runtime.closeAllProfiles();
  await assert.rejects(h.runtime.launchProfileWindow(payload()), /перезапустите Umbra/);
});

test("unavailable font isolation cannot open network or profile windows", async () => {
  const h = harness();
  await assert.rejects(h.runtime.launchProfileWindow({ ...payload(), fingerprint: { ...FP, fontIsolation: true } }), /изоляции шрифтов/);
  assert.equal(h.configured, 0);
  assert.equal(h.windows.length, 0);
});

test("strict startup clears stale service workers while normal startup preserves them", async () => {
  for (const aggressivePrivacyMode of [undefined, true]) {
    const h = harness();
    const launch = payload();
    if (aggressivePrivacyMode !== undefined) launch.fingerprint = { ...FP, aggressivePrivacyMode };
    await h.runtime.launchProfileWindow(launch);
    assert.deepEqual(h.storageClears.filter((item) => item?.storages?.includes("serviceworkers")), [{ storages: ["serviceworkers"] }]);
    assert.equal(h.browserConfig.getPrivacy("https://example.test/").mode, "strict");
    await h.runtime.closeAllProfiles();
  }
  const normal = harness();
  await normal.runtime.launchProfileWindow({ ...payload(), fingerprint: { ...FP, aggressivePrivacyMode: false } });
  assert.deepEqual(normal.storageClears.filter((item) => item?.storages?.includes("serviceworkers")), [], "normal mode must not remove existing site service workers");
  assert.deepEqual(normal.browserConfig.getPrivacy("https://example.test/"), {
    origin: "https://example.test", mode: "normal", allowed: true,
    permissions: ["gpu", "canvas", "audio", "workers"],
  });
  const normalSession = normal.sessions.get(`persist:profile-${ID}`);
  assert.equal(normalSession.permissionCheck(null, "local-fonts", "https://example.test"), false, "normal mode does not silently grant access to host fonts");
  await assert.rejects(normal.browserConfig.setPrivacy("https://example.test", ["workers"]), /обычном режиме/);
  assert.ok(normal.runtime.getRunningProfile(ID), "rejecting an inapplicable per-site setting must leave the profile running");
  await normal.runtime.closeAllProfiles();
});

test("privacy consent closes profile durably and applies to one origin after restart", async () => {
  const h = harness();
  const closures = [];
  await h.runtime.launchProfileWindow(payload(), (snapshot) => closures.push(snapshot));
  const ses = h.sessions.get(`persist:profile-${ID}`);
  await ses.cookies.set({ url: "https://example.test/", name: "fixture", value: "persist-me" });
  assert.equal(h.browserConfig.getPrivacy("https://example.test/").allowed, false);
  await h.browserConfig.setPrivacy("https://example.test", ["workers"]);
  assert.equal(h.runtime.getRunningProfile(ID), null);
  assert.equal(closures.length, 1);
  assert.match(closures[0].cookies, /persist-me/);
  await h.runtime.launchProfileWindow(payload());
  assert.equal(h.browserConfig.getPrivacy("https://example.test/path").allowed, true);
  assert.deepEqual(h.browserConfig.getPrivacy("https://example.test/path").permissions, ["workers"]);
  assert.equal(h.browserConfig.getPrivacy("https://sub.example.test/").allowed, false);
  assert.equal(h.browserConfig.getPrivacy("http://example.test/").allowed, false);
  await h.browserConfig.setPrivacy("https://example.test", []);
  await h.runtime.launchProfileWindow(payload());
  assert.equal(h.browserConfig.getPrivacy("https://example.test").allowed, false);
  await h.browserConfig.setPrivacy("https://example.test", ["fonts"]);
  await h.runtime.launchProfileWindow(payload());
  assert.equal(ses.permissionCheck(null, "local-fonts", "https://example.test"), true);
  assert.equal(ses.permissionCheck(null, "local-fonts", "https://sub.example.test"), false);
  assert.equal(ses.permissionCheck(null, "camera", "https://example.test"), false);
  let granted;
  ses.permissionRequest(null, "local-fonts", (result) => { granted = result; }, { requestingUrl: "https://example.test/path" });
  assert.equal(granted, true);
  ses.permissionRequest(null, "local-fonts", (result) => { granted = result; }, { requestingUrl: "https://sub.example.test/path" });
  assert.equal(granted, false);
  await h.runtime.closeAllProfiles();
});

test("team bookmarks update in running profiles without changing personal bookmarks", async () => {
  const h = harness();
  const teamId = "20000000-0000-4000-8000-000000000001";
  const personal = { id: ID, title: "Личная", url: "https://personal.test/" };
  h.bookmarkRecords.set(ID, { bookmarks: [personal], barVisible: false, stored: true });
  await h.runtime.launchProfileWindow({ ...payload(), bookmarkDefaults: {
    teamId, bookmarks: [{ id: teamId, title: "Команда", url: "https://team.test/" }], bookmarkBarVisible: true,
  } });
  assert.equal(h.browserConfig.getBookmarkBarVisible(), true);
  assert.equal(h.browserConfig.getBookmarks().length, 2);
  await h.runtime.applyBookmarkDefaults({ teamId: ID, bookmarks: [] });
  assert.equal(h.browserConfig.getBookmarks().length, 2);
  await h.runtime.applyBookmarkDefaults({ teamId, bookmarks: [], bookmarkBarVisible: true });
  assert.deepEqual(h.browserConfig.getBookmarks(), [personal]);
  assert.deepEqual(h.bookmarkRecords.get(ID).bookmarks, [personal]);
  await h.runtime.closeAllProfiles();
});

test("saved tabs reopen beside one pinned home page, which becomes active", async () => {
  const h = harness();
  h.tabRecords.set(ID, { tabs: ["https://one.test/", "https://two.test/"], activeIndex: 1 });
  const launch = payload();
  delete launch.startUrl;
  launch.fingerprint = { ...FP, startUrl: "https://home.test/" };
  await h.runtime.launchProfileWindow(launch);
  assert.deepEqual(h.windows.map((win) => win.url), ["about:blank", "https://one.test/", "https://two.test/"]);
  assert.equal(h.windows[0].shown, true);
  assert.equal(h.windows[1].shown, undefined);
  assert.equal(h.windows[2].shown, undefined);
  await h.runtime.closeAllProfiles();
  assert.deepEqual(h.tabRecords.get(ID).tabs, ["https://one.test/", "https://two.test/"]);
  await h.runtime.launchProfileWindow(launch);
  assert.deepEqual(h.windows.slice(3).map((win) => win.url), ["about:blank", "https://one.test/", "https://two.test/"]);
  assert.equal(h.windows[3].shown, true);
  await h.runtime.closeAllProfiles();
});

test("live cookie import is encrypted locally before it is reported as complete", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload());
  const result = await h.browserConfig.importCookies(JSON.stringify([{ domain: "example.test", path: "/", name: "imported", value: "secret" }]));
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 0);
  assert.ok(result.cookiesUpdatedAt);
  assert.equal(h.records.get(ID).cookies.some((entry) => entry.name === "imported" && entry.value === "secret"), true);
  await h.runtime.closeAllProfiles();
});

test("hidden profile browser stays hidden without maximizing", async () => {
  const calls = [];
  class Shell extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.contentView = { addChildView() {}, removeChildView() {} };
      Object.assign(this.webContents, {
        setWindowOpenHandler() {},
        loadURL: async () => {},
        send() {},
        focus() {},
      });
    }
    maximize() { calls.push("maximize"); }
    show() { calls.push("show"); }
    async loadURL() {}
    isDestroyed() { return false; }
    destroy() { this.emit("closed"); }
    getContentBounds() { return { width: 1920, height: 1080 }; }
  }
  const ipcMain = { handle() {}, removeHandler() {} };
  const { createProfileBrowser } = require("../runtime/browser.cjs");
  const browser = await createProfileBrowser({
    BrowserWindow: Shell,
    WebContentsView: class {},
    ipcMain,
    session: { fromPartition: () => ({
      webRequest: { onBeforeRequest() {} },
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    }) },
  }, {
    name: "Test",
    fp: FP,
    partition: `persist:profile-${ID}`,
    openTab: async () => {},
    closeProfile: async () => {},
    show: false,
  });
  assert.deepEqual(calls, []);
  browser.destroy();
});

test("concurrent launches deduplicate before async work and popup inherits hardened profile settings", async () => {
  const h = harness();
  const p1 = h.runtime.launchProfileWindow(payload());
  const p2 = h.runtime.launchProfileWindow(payload());
  assert.strictEqual(p1, p2);
  await p1;
  assert.equal(h.configured, 1);
  assert.equal(h.windows.length, 2);
  const first = h.windows[0];
  assert.equal(first.options.webPreferences.partition, `persist:profile-${ID}`);
  assert.deepEqual(first.openHandler({ url: "https://popup.test" }), { action: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.windows.length, 3);
  assert.deepEqual(h.windows[2].options.webPreferences, first.options.webPreferences);
  assert.equal(h.windows[2].policy, "disable_non_proxied_udp");
  assert.equal(first.options.webPreferences.contextIsolation, true);
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(h.runtime.getRunningProfile(ID).lockToken, "test-lock-token");
  assert.equal(h.runtime.getRunningProfile(ID).deviceId, "test-device");
  assert.equal((await h.runtime.snapshotProfileCookies(ID)).deviceId, "test-device");
  await h.runtime.closeAllProfiles();
  assert.equal(h.disposed, 1);
});

test("close waits for cookie flush and durable onClosed callback before destroying windows", async () => {
  const h = harness();
  const callbackGate = defer();
  const calls = [];
  await h.runtime.launchProfileWindow(payload(), async (snapshot) => { calls.push(snapshot); assert.equal(h.windows[0].destroyed, false); await callbackGate.promise; });
  const ses = h.sessions.get(`persist:profile-${ID}`);
  ses.cookies.update([{ name: "session", value: "v", domain: "example.test", path: "/", session: true }]);
  const flushGate = defer(); h.setFlushGate(flushGate);
  let complete = false;
  const closing = h.runtime.closeProfileWindow(ID).then(() => { complete = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(complete, false); assert.equal(calls.length, 0); assert.equal(h.windows[0].destroyed, false);
  flushGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].lockToken, "test-lock-token"); assert.equal(complete, false);
  assert.equal(calls[0].deviceId, "test-device");
  callbackGate.resolve(); await closing;
  assert.equal(h.windows[0].destroyed, true); assert.deepEqual(h.runtime.listRunningProfiles(), []);
});

test("snapshot failures retain the window and allow retry; snapshots carry monotonically increasing revisions", async () => {
  const h = harness(); let closed = 0;
  await h.runtime.launchProfileWindow(payload(), () => { closed++; });
  const previous = await h.runtime.snapshotProfileCookies(ID);
  h.sessions.get(`persist:profile-${ID}`).cookies.update([{ name: "changed", value: "v", domain: "example.test", path: "/", session: true }]);
  h.setSnapshotFailure(true);
  await assert.rejects(h.runtime.closeProfileWindow(ID), /Не удалось закрыть профиль/);
  assert.equal(h.shell.hidden, false, "save failure must restore the shell for retry");
  assert.equal(h.windows[0].destroyed, false); assert.equal(closed, 0);
  h.setSnapshotFailure(false);
  const result = await h.runtime.closeProfileWindow(ID);
  assert.ok(Date.parse(result.cookiesUpdatedAt) > Date.parse(previous.cookiesUpdatedAt));
  assert.equal(closed, 1); assert.equal(h.windows[0].destroyed, true);
});

test("failed or stalled worker shutdown cannot trap a profile window after durable save", async () => {
  for (const stop of [async () => { throw new Error("debugger detached"); }, () => new Promise(() => {})]) {
    const h = harness();
    let saved = 0;
    await h.runtime.launchProfileWindow(payload(), () => { saved++; });
    h.sessions.get(`persist:profile-${ID}`).cookies.update([{ name: "session", value: "v", domain: "example.test", path: "/", session: true }]);
    h.setWorkerStop(stop);
    await h.runtime.closeProfileWindow(ID);
    assert.equal(saved, 1);
    assert.equal(h.windows[0].destroyed, true);
    assert.deepEqual(h.runtime.listRunningProfiles(), []);
    assert.equal(h.records.get(ID).cookies[0].name, "session");
    await assert.rejects(h.runtime.launchProfileWindow(payload()), /Перезапустите Umbra/);
  }
});

test("close hides immediately, blocks reopen while pending, and tolerates delayed shutdown", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload());
  const stopped = defer();
  h.setWorkerStop(() => stopped.promise);
  let disconnected = false;
  h.sessions.get(`persist:profile-${ID}`).closeAllConnections = async () => { disconnected = true; };
  const closing = h.runtime.closeProfileWindow(ID);
  assert.equal(h.shell.hidden, true);
  await assert.rejects(h.runtime.launchProfileWindow(payload()), /закрывается/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(disconnected, true, "connection shutdown must not wait for worker reply");
  stopped.resolve(); await closing;
  await h.runtime.launchProfileWindow(payload());
  await h.runtime.closeAllProfiles();
});

test("continuous cookie updates cannot starve the encrypted checkpoint", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload());
  const ses = h.sessions.get(`persist:profile-${ID}`);
  const change = () => ses.cookies.update([{ name: "busy", value: "checkpoint", domain: "example.test", path: "/", session: true }]);
  change();
  const interval = setInterval(change, 30);
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(h.records.get(ID).cookies[0]?.name, "busy");
  } finally { clearInterval(interval); await h.runtime.closeAllProfiles(); }
});

const CLOUD_BASE = "2026-01-01T00:00:00.000Z";
const CLOUD_SAVED = "2026-02-01T00:00:00.000Z";
const savedCookie = (value) => ({ name: "fixture", value, domain: "example.test", path: "/", session: true });
const cookieAcknowledgement = (snapshot, cloudRevision = CLOUD_SAVED) => ({
  profileId: snapshot.profileId, lockToken: snapshot.lockToken, snapshotId: snapshot.snapshotId,
  snapshotRevision: snapshot.snapshotRevision, cloudRevision,
});

test("save identity is durable before upload and server proof rebases C without replacing it", async t => {
  const h = harness(); t.after(() => h.runtime.closeAllProfiles());
  await h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: CLOUD_BASE });
  const ses = h.sessions.get(`persist:profile-${ID}`);
  ses.cookies.update([savedCookie("B")]);
  const sent = await h.runtime.snapshotProfileCookies(ID, 1);
  assert.equal(h.records.get(ID).saveAttempts[0].saveId, sent.snapshotId);
  assert.equal(h.records.get(ID).saveAttempts[0].cookieHash, sent.cookieHash);
  assert.equal(sent.baseRevision, CLOUD_BASE);
  ses.cookies.update([savedCookie("C")]);
  const newer = await h.runtime.snapshotProfileCookies(ID, 1);
  const proof = { saveId: sent.snapshotId, cookieHash: sent.cookieHash, cookiesUpdatedAt: CLOUD_SAVED };
  for (const invalid of [{ ...proof, saveId: crypto.randomUUID() }, { ...proof, cookieHash: "0".repeat(64) }]) {
    assert.equal(await h.runtime.reconcileProfileCookieSave({ profileId: ID, lockToken: "test-lock-token", proof: invalid }), false);
  }
  h.setSnapshotFailure(true);
  await assert.rejects(h.runtime.reconcileProfileCookieSave({ profileId: ID, lockToken: "test-lock-token", proof }), /disk failure/);
  assert.equal(h.records.get(ID).baseRevision, CLOUD_BASE);
  assert.equal(h.records.get(ID).saveAttempts.length, 2);
  h.setSnapshotFailure(false);
  assert.equal(await h.runtime.reconcileProfileCookieSave({ profileId: ID, lockToken: "test-lock-token", proof }), true);
  assert.equal(h.records.get(ID).cookies[0].value, "C");
  assert.equal(h.records.get(ID).cookiesUpdatedAt, newer.cookiesUpdatedAt);
  assert.equal(h.records.get(ID).baseRevision, CLOUD_SAVED);
  assert.equal(h.records.get(ID).saveAttempts.length, 0);
  assert.equal((await h.runtime.snapshotProfileCookies(ID, 1)).unchanged, false, "C still needs saving");
});

test("long offline journal is bounded without forgetting the oldest possible committed save", async t => {
  const h = harness(); t.after(() => h.runtime.closeAllProfiles());
  await h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: CLOUD_BASE });
  const ses = h.sessions.get(`persist:profile-${ID}`);
  assert.equal((await h.runtime.snapshotProfileCookies(ID, 1)).unchanged, true);
  assert.equal(h.records.get(ID).saveAttempts.length, 0);
  const attempts = [];
  for (let i = 0; i < 16; i++) {
    ses.cookies.update([savedCookie(String(i))]); attempts.push(await h.runtime.snapshotProfileCookies(ID, 1));
  }
  assert.equal((await h.runtime.snapshotProfileCookies(ID, 1)).snapshotId, attempts[15].snapshotId, "same content reuses its identity");
  ses.cookies.update([savedCookie("latest")]);
  await assert.rejects(h.runtime.snapshotProfileCookies(ID, 1), /flush encrypted/);
  assert.equal(h.records.get(ID).saveAttempts.length, 16);
  assert.equal(h.records.get(ID).cookies[0].value, "latest", "local checkpoint remains durable even when journal is full");
  const proof = { saveId: attempts[0].snapshotId, cookieHash: attempts[0].cookieHash, cookiesUpdatedAt: CLOUD_SAVED };
  assert.equal(await h.runtime.reconcileProfileCookieSave({ profileId: ID, lockToken: "test-lock-token", proof }), true);
  const current = await h.runtime.snapshotProfileCookies(ID, 1);
  assert.equal(current.baseRevision, CLOUD_SAVED);
  assert.equal(h.records.get(ID).saveAttempts.length, 1);
});

test("an old panel cannot fill the durable-save journal it does not know how to acknowledge", async t => {
  const h = harness(); t.after(() => h.runtime.closeAllProfiles());
  await h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: CLOUD_BASE });
  const ses = h.sessions.get(`persist:profile-${ID}`);
  for (let index = 0; index < 20; index++) {
    ses.cookies.update([savedCookie(String(index))]);
    await h.runtime.snapshotProfileCookies(ID);
  }
  assert.equal(h.records.get(ID).saveAttempts.length, 0);
});

test("a late cloud acknowledgement rebases the latest checkpoint without losing newer cookies", async (t) => {
  const h = harness();
  t.after(() => h.runtime.closeAllProfiles());
  await h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: CLOUD_BASE });
  const ses = h.sessions.get(`persist:profile-${ID}`);
  ses.cookies.update([savedCookie("sent")]);
  const sent = await h.runtime.snapshotProfileCookies(ID);
  ses.cookies.update([savedCookie("changed-during-request")]);
  const flush = defer();
  h.setFlushGate(flush);
  const newerPending = h.runtime.snapshotProfileCookies(ID);
  await new Promise(resolve => setImmediate(resolve));
  let acknowledged = false;
  const acknowledgement = h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(sent)).then(applied => { acknowledged = true; return applied; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false, "acknowledgement waits behind the in-flight checkpoint");
  flush.resolve();
  h.setFlushGate(null);
  const newer = await newerPending;
  assert.notEqual(newer.snapshotId, sent.snapshotId);
  assert.ok(newer.snapshotSequence > sent.snapshotSequence);
  assert.equal(await acknowledgement, true);
  assert.equal(h.records.get(ID).cookies[0].value, "changed-during-request");
  assert.equal(h.records.get(ID).cookiesUpdatedAt, newer.cookiesUpdatedAt);
  assert.equal(h.records.get(ID).baseRevision, CLOUD_SAVED);
  assert.equal(h.records.get(ID).pending, true);
  ses.cookies.update([savedCookie("changed-after-ack")]);
  await h.runtime.snapshotProfileCookies(ID);
  assert.equal(h.records.get(ID).cookies[0].value, "changed-after-ack");
  assert.equal(h.records.get(ID).baseRevision, CLOUD_SAVED, "future checkpoints retain the confirmed cloud base");
});

test("cookie acknowledgements reject wrong receipts, tokens, revisions and out-of-order replies", async (t) => {
  const h = harness();
  t.after(() => h.runtime.closeAllProfiles());
  await h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: CLOUD_BASE });
  const sent = await h.runtime.snapshotProfileCookies(ID);
  const newer = await h.runtime.snapshotProfileCookies(ID);
  assert.equal(newer.snapshotRevision, sent.snapshotRevision, "unchanged cookies still get distinct receipt IDs");
  for (const change of [
    { lockToken: "another-session" },
    { snapshotId: "20000000-0000-4000-8000-000000000002" },
    { snapshotRevision: "2026-01-02T00:00:00.000Z" },
    { profileId: "20000000-0000-4000-8000-000000000002" },
    { cloudRevision: "2025-01-01T00:00:00.000Z" },
  ]) {
    const before = h.records.get(ID);
    assert.equal(await h.runtime.acknowledgeProfileCookies({ ...cookieAcknowledgement(sent), ...change }), false);
    assert.equal(h.records.get(ID), before, "a rejected receipt must not write the checkpoint");
  }
  assert.equal(await h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(newer)), true);
  const confirmed = h.records.get(ID);
  assert.equal(await h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(sent, "2026-03-01T00:00:00.000Z")), false);
  assert.equal(await h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(newer)), false, "duplicate acknowledgement is harmless");
  assert.equal(h.records.get(ID), confirmed);
});

test("a failed durable acknowledgement keeps the old base and remains retryable", async (t) => {
  const h = harness();
  t.after(() => { h.setSnapshotFailure(false); return h.runtime.closeAllProfiles(); });
  await h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: CLOUD_BASE });
  const sent = await h.runtime.snapshotProfileCookies(ID);
  h.setSnapshotFailure(true);
  await assert.rejects(h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(sent)), /simulated disk failure/);
  assert.equal(h.records.get(ID).baseRevision, CLOUD_BASE);
  h.setSnapshotFailure(false);
  h.sessions.get(`persist:profile-${ID}`).cookies.update([savedCookie("newer-local")]);
  const newer = await h.runtime.snapshotProfileCookies(ID);
  assert.equal(h.records.get(ID).baseRevision, CLOUD_BASE, "failed writes cannot advance the in-memory cloud base");
  assert.equal(await h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(sent)), true);
  assert.equal(h.records.get(ID).cookies[0].value, "newer-local");
  assert.equal(h.records.get(ID).cookiesUpdatedAt, newer.cookiesUpdatedAt);
  assert.equal(h.records.get(ID).baseRevision, CLOUD_SAVED);
});

test("closing and a replacement session cannot acknowledge the previous session's cookies", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow({ ...payload(), cookiesUpdatedAt: CLOUD_BASE });
  const sent = await h.runtime.snapshotProfileCookies(ID);
  const stopped = defer();
  h.setWorkerStop(() => stopped.promise);
  const closing = h.runtime.closeProfileWindow(ID);
  const before = h.records.get(ID);
  assert.equal(await h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(sent)), false);
  assert.equal(h.records.get(ID), before);
  stopped.resolve();
  await closing;
  await h.runtime.launchProfileWindow({ ...payload(), lockToken: "replacement-session", cookiesUpdatedAt: CLOUD_BASE });
  try {
    assert.equal(await h.runtime.acknowledgeProfileCookies(cookieAcknowledgement(sent)), false);
    assert.equal(h.records.get(ID).baseRevision, CLOUD_BASE);
  } finally { await h.runtime.closeAllProfiles(); }
});

test("crashed renderer debugger rejection or timeout does not block profile close", async () => {
  for (const freeze of [async () => { throw new Error("renderer gone"); }, () => new Promise(() => {})]) {
    const h = harness();
    let saved = 0;
    await h.runtime.launchProfileWindow(payload(), () => { saved++; });
    h.setFreezeCommand(freeze);
    await h.runtime.closeProfileWindow(ID);
    assert.equal(saved, 1);
    assert.equal(h.windows[0].destroyed, true);
    assert.deepEqual(h.runtime.listRunningProfiles(), []);
  }
});

test("a closed or crashed tab target does not close the whole profile", async () => {
  const h = harness();
  let closed = 0;
  await h.runtime.launchProfileWindow(payload(), () => { closed++; });
  const tab = h.windows[0];

  // Chromium emits this debugger-detach reason when the renderer target goes
  // away. Fingerprint protection for a still-live target remains fail-closed;
  // this target is already gone and must not take the shared profile with it.
  tab.webContents.debugger.emit("detach", {}, "target closed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed, 0);
  assert.equal(tab.destroyed, false);
  assert.equal(h.runtime.listRunningProfiles().length, 1);
  await h.runtime.closeAllProfiles();
  assert.equal(closed, 1);
});

test("stalled connection or proxy cleanup still saves cookies and requires restart", async () => {
  for (const stall of ["connections", "proxy"]) {
    const h = harness();
    let saved = 0;
    await h.runtime.launchProfileWindow(payload(), () => { saved++; });
    if (stall === "connections") h.sessions.get(`persist:profile-${ID}`).closeAllConnections = () => new Promise(() => {});
    else h.setProxyDispose(() => new Promise(() => {}));
    await h.runtime.closeProfileWindow(ID);
    assert.equal(saved, 1);
    assert.equal(h.windows[0].destroyed, true);
    await assert.rejects(h.runtime.launchProfileWindow(payload()), /Перезапустите Umbra/);
  }
});

test("fingerprint camelCase/legacy mappings and document overrides precede navigation", async () => {
  const fp = normalizeFingerprint(FP);
  assert.equal(fp.hardwareConcurrency, 6); assert.equal(fp.screen.width, 1920);
  assert.equal(normalizeFingerprint({ user_agent: "Chrome/140.0.0.0", screen_width: 1600, hardware_concurrency: 4 }).screen.width, 1600);
  assert.equal(userAgentOverride(fp).userAgentMetadata.brands[0].version, "144");
  const h = harness(); await h.runtime.launchProfileWindow(payload());
  const script = h.windows[0].commands.find((c) => c.command === "Page.addScriptToEvaluateOnNewDocument").args;
  assert.equal(Object.hasOwn(script, "worldName"), false);
  const context = vm.createContext({ navigator: {}, screen: {} });
  vm.runInContext(script.source, context);
  assert.equal(context.navigator.hardwareConcurrency, 6);
  assert.equal(context.navigator.language, "de-DE"); assert.equal(context.screen.width, 1920);
  await h.runtime.closeAllProfiles();
});

test("profile permissions deny device identity, geolocation and display capture", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload());
  const ses = h.sessions.get(`persist:profile-${ID}`);
  for (const permission of ["geolocation", "media", "notifications", "display-capture", "usb", "serial", "hid"]) {
    let granted;
    ses.permissionRequest(null, permission, (result) => { granted = result; });
    assert.equal(granted, false);
    assert.equal(ses.permissionCheck(null, permission), false);
  }
  for (const deviceType of ["hid", "usb", "serial"]) assert.equal(ses.devicePermission({ deviceType }), false);
  let streams;
  ses.displayMedia({ videoRequested: true }, (result) => { streams = result; });
  assert.deepEqual(streams, {});
  await h.runtime.closeAllProfiles();
});

test("closing an in-flight launch cleans up and does not leave a stale registry entry", async () => {
  const h = harness(); const gate = defer(); h.setNavigationGate(gate);
  const launch = h.runtime.launchProfileWindow(payload());
  const rejected = assert.rejects(launch, /Профиль закрывается/);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = h.runtime.closeProfileWindow(ID);
  gate.resolve(); await rejected; await closing;
  assert.deepEqual(h.runtime.listRunningProfiles(), []);
  assert.equal(h.windows[0].destroyed, true);
});
