const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createPanelStartup, startupUrl, panelBackground } = require("../runtime/panel-startup.cjs");

function fixture({ loadURL = async () => {}, localFailure = false, localPanel = () => false, prepare, showError = async () => false } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let view;
  let destroyed = false;
  class Contents extends EventEmitter {
    setWindowOpenHandler(handler) { this.open = handler; }
    async loadURL(url) { calls.push(["local", url]); if (localFailure) throw new Error("local paint failed"); }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; calls.push(["dispose"]); }
    focus() { calls.push(["focus"]); }
    stop() { calls.push(["stop"]); }
  }
  const localSession = {
    setPermissionRequestHandler(handler) { this.permission = handler; },
    setPermissionCheckHandler(handler) { this.checkPermission = handler; },
    webRequest: { onBeforeRequest(_filter, handler) { localSession.request = handler; } },
  };
  const electron = {
    session: { fromPartition(name, options) { calls.push(["session", name, options]); return localSession; } },
    WebContentsView: class {
      constructor(options) { this.options = options; this.webContents = new Contents(); view = this; }
      setBackgroundColor(color) { this.background = color; }
      setBounds(bounds) { this.bounds = bounds; }
    },
  };
  const window = new EventEmitter();
  window.webContents = new Contents();
  Object.assign(window, {
    isDestroyed: () => destroyed,
    getContentBounds: () => ({ width: 1440, height: 900 }),
    maximize: () => calls.push(["maximize"]), show: () => calls.push(["show"]),
    loadURL: (url, options) => { calls.push(["remote", url, options]); return loadURL(url); },
    close: () => { destroyed = true; window.emit("closed"); calls.push(["close"]); },
    contentView: { addChildView: () => calls.push(["attach"]), removeChildView: () => calls.push(["detach"]) },
  });
  const startup = createPanelStartup(electron, window, {
    appUrl: "https://panel.example/app", version: "0.4.42", prepare, showError,
    localPanel,
    schedule: (cb, delay) => { const id = ++nextTimer; timers.set(id, { cb, delay }); return id; },
    cancel: id => timers.delete(id),
  });
  return { calls, timers, window, startup, view, localSession };
}

test("one native window is visible before preparation or the first network request", async () => {
  let release;
  const fixturePromise = new Promise(resolve => { release = resolve; });
  const f = fixture({ prepare: fixturePromise });
  assert.equal(f.calls.filter(([action]) => action === "show").length, 1);
  const loading = f.startup.start();
  assert.strictEqual(f.startup.start(), loading);
  await Promise.resolve();
  assert.equal(f.calls.filter(([action]) => action === "remote").length, 0);
  release(); await loading;
  const navigation = f.calls.find(([action]) => action === "remote");
  assert.equal(navigation[1], "https://panel.example/app?desktop=0.4.42");
  assert.equal(navigation[2], undefined, "do not force cache bypass");
  assert.equal(f.view.bounds.width, 1440);
  f.startup.ready();
  assert.equal(f.startup.state().ready, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.window.listenerCount("resize"), 0);
  f.startup.ready();
  assert.equal(f.calls.filter(([action]) => action === "dispose").length, 1);
});

test("verified anonymous local UI is revealed without waiting for network auth/hydration IPC", async () => {
  const f = fixture({ localPanel: () => true });
  await f.startup.start();
  assert.equal(f.startup.state().ready, true);
  assert.equal(f.startup.state().disposed, true);
  assert.equal(f.timers.size, 0);
});

test("local skeleton has no secrets, preload, JS, persistent storage or network", () => {
  const f = fixture();
  const prefs = f.view.options.webPreferences;
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.javascript, false);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(f.calls[0][1].startsWith("persist:"), false);
  assert.equal(f.localSession.checkPermission(), false);
  f.localSession.request({}, result => assert.equal(result.cancel, true));
  assert.equal(f.view.webContents.open().action, "deny");
  const html = decodeURIComponent(startupUrl().split(",")[1]);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script|https:\/\/|Umbra запускается/);
  assert.match(panelBackground, /^rgb\(\d+, \d+, \d+\)$/);
  f.startup.dispose();
});

test("every retry has a separate deadline; closing cannot resurrect the window", async () => {
  let attempts = 0;
  let prompts = 0;
  const f = fixture({ loadURL: async () => { if (++attempts < 3) throw new Error("offline"); }, showError: async () => { prompts++; return false; } });
  await f.startup.start();
  assert.equal(attempts, 3);
  assert.equal(prompts, 0);
  assert.equal(f.timers.size, 1, "only legacy ready fallback remains");
  f.window.close();
  assert.equal(f.timers.size, 0);
  assert.equal(f.startup.state().disposed, true);
  assert.equal(f.calls.filter(([action]) => action === "show").length, 1);
});

test("offline startup offers bounded retry in the same window", async () => {
  let prompts = 0;
  const f = fixture({ loadURL: async () => { throw new Error("offline"); }, showError: async () => ++prompts === 1 });
  await f.startup.start();
  assert.equal(f.calls.filter(([action]) => action === "remote").length, 6);
  assert.equal(prompts, 2);
  assert.equal(f.calls.filter(([action]) => action === "close").length, 1);
  assert.equal(f.timers.size, 0);
});

test("legacy panels reveal after fallback and preparation failures never load remote content", async () => {
  const f = fixture();
  await f.startup.start();
  [...f.timers.values()][0].cb();
  assert.equal(f.startup.state().ready, true);
  const bad = fixture({ prepare: Promise.reject(new Error("protection failed")) });
  await assert.rejects(bad.startup.start(), /protection failed/);
  assert.equal(bad.calls.filter(([action]) => action === "remote").length, 0);
  bad.startup.dispose();
});

test("navigation timeout cancels the current request and does not hang startup", async () => {
  let prompts = 0;
  const f = fixture({ loadURL: () => new Promise(() => {}), showError: async () => { prompts++; return false; } });
  const loading = f.startup.start();
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
    const timer = [...f.timers.values()].find(timer => timer.delay === 20_000);
    assert.ok(timer);
    timer.cb();
  }
  await loading;
  assert.equal(prompts, 1);
  assert.equal(f.calls.filter(([action]) => action === "stop").length, 3);
  assert.equal(f.timers.size, 0);
});

test("failure of the optional local paint cannot prevent loading the trusted panel", async () => {
  const f = fixture({ localFailure: true });
  await f.startup.start();
  assert.equal(f.calls.filter(([action]) => action === "remote").length, 1);
  assert.equal(f.startup.state().loaded, true);
});

test("closing while protection initializes skips remote navigation and removes the shell", async () => {
  let release;
  const f = fixture({ prepare: new Promise(resolve => { release = resolve; }) });
  const loading = f.startup.start();
  f.window.close(); release(); await loading;
  assert.equal(f.calls.filter(([action]) => action === "remote").length, 0);
  assert.equal(f.calls.filter(([action]) => action === "dispose").length, 1);
});
