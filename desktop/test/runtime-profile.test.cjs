const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { createProfileRuntime } = require("../runtime/profile-runtime.cjs");
const { normalizeFingerprint, applyFingerprint, userAgentOverride } = require("../runtime/fingerprint.cjs");
const ID = "10000000-0000-4000-8000-000000000001";
const FP = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0", languages: ["de-DE", "de"], timezone: "Europe/Berlin", hardwareConcurrency: 6, screen: { width: 1920, height: 1080, colorDepth: 24 } };
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function harness() {
  const windows = [];
  const sessions = new Map();
  let configured = 0;
  let disposed = 0;
  let flushGate = null;
  let navigationGate = null;
  let snapshotFailure = false;
  const records = new Map();
  const tabRecords = new Map();
  const bookmarkRecords = new Map();
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        setUserAgent: (ua) => { this.ua = ua; },
        setWebRTCIPHandlingPolicy: (policy) => { this.policy = policy; },
        getWebRTCIPHandlingPolicy: () => this.policy,
        setWindowOpenHandler: (handler) => { this.openHandler = handler; }, stop: () => {},
      });
      this.webContents.debugger = new EventEmitter();
      Object.assign(this.webContents.debugger, { attach: () => {}, isAttached: () => true, detach: () => {}, sendCommand: async (command, args) => { this.commands.push({ command, args }); } });
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
      const ses = { cookies, webRequest: { onBeforeRequest() {} }, getUserAgent: () => "Chrome/144.0.0.0", setUserAgent() {}, flushStorageData() {}, closeAllConnections: async () => {}, clearStorageData: async () => { data = []; }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
      sessions.set(partition, ses); return ses;
    } },
  };
  const runtime = createProfileRuntime(electron, {
    createBrowser: async (_electron, options) => ({
      shell: { isDestroyed: () => false, focus() {} }, destroy() {},
      createTab: () => new Window({ webPreferences: { partition: options.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } }),
    }),
    setupProxy: async () => { configured++; return { diagnostics: { mode: "http" }, dispose: async () => { disposed++; } }; },
    cookieStore: {
      read: async (id) => records.get(id),
      write: async (id, cookies, cookiesUpdatedAt) => { if (snapshotFailure) throw new Error("simulated disk failure"); records.set(id, { cookies, cookiesUpdatedAt }); },
    },
    tabStore: {
      read: async (id) => tabRecords.get(id) || { tabs: [], activeIndex: 0 },
      write: async (id, tabs, activeIndex) => { tabRecords.set(id, { tabs: [...tabs], activeIndex }); },
    },
    bookmarkStore: {
      readState: async (id) => bookmarkRecords.get(id) || { bookmarks: [], barVisible: true },
      write: async (id, state) => { bookmarkRecords.set(id, structuredClone(state)); return structuredClone(state); },
    },
  });
  return { runtime, windows, sessions, records, tabRecords, bookmarkRecords, get configured() { return configured; }, get disposed() { return disposed; }, setFlushGate: (gate) => { flushGate = gate; }, setNavigationGate: (gate) => { navigationGate = gate; }, setSnapshotFailure: (value) => { snapshotFailure = value; } };
}

const payload = () => ({ profileId: ID, deviceId: "test-device", name: "Test", lockToken: "test-lock-token", fingerprint: FP, cookies: "[]", cookiesUpdatedAt: null, proxy: null, startUrl: "https://example.test" });

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
  assert.equal(h.windows.length, 1);
  const first = h.windows[0];
  assert.equal(first.options.webPreferences.partition, `persist:profile-${ID}`);
  assert.deepEqual(first.openHandler({ url: "https://popup.test" }), { action: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.windows.length, 2);
  assert.deepEqual(h.windows[1].options.webPreferences, first.options.webPreferences);
  assert.equal(h.windows[1].policy, "disable_non_proxied_udp");
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
  await assert.rejects(h.runtime.closeProfileWindow(ID), /close failed/);
  assert.equal(h.windows[0].destroyed, false); assert.equal(closed, 0);
  h.setSnapshotFailure(false);
  const result = await h.runtime.closeProfileWindow(ID);
  assert.ok(Date.parse(result.cookiesUpdatedAt) > Date.parse(previous.cookiesUpdatedAt));
  assert.equal(closed, 1); assert.equal(h.windows[0].destroyed, true);
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

test("closing an in-flight launch cleans up and does not leave a stale registry entry", async () => {
  const h = harness(); const gate = defer(); h.setNavigationGate(gate);
  const launch = h.runtime.launchProfileWindow(payload());
  const rejected = assert.rejects(launch, /closing/);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = h.runtime.closeProfileWindow(ID);
  gate.resolve(); await rejected; await closing;
  assert.deepEqual(h.runtime.listRunningProfiles(), []);
  assert.equal(h.windows[0].destroyed, true);
});
