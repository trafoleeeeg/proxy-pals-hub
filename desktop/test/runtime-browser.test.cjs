const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createProfileBrowser, CHROME_HEIGHT } = require("../runtime/browser.cjs");

function harness() {
  let handler;
  const stateEvents = [];
  const views = [];
  let layoutCount = 0;
  class Contents extends EventEmitter {
    constructor() {
      super(); this.url = "about:blank"; this.title = ""; this.loading = false;
      this.session = { fetch: async () => { throw new Error("offline fixture"); } };
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
      this.mainFrame = {};
    }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    isLoading() { return this.loading; }
    isDestroyed() { return false; }
    async loadURL(url) { this.url = url; this.title = url === "about:blank" ? "" : new URL(url).hostname; this.emit("did-navigate", {}, url); }
    reload() {}
    stop() {}
    focus() {}
    close() { this.destroyed = true; this.emit("destroyed"); }
    setWindowOpenHandler() {}
    send(channel, state) { if (channel === "umbra-runtime:state") stateEvents.push(state); }
  }
  class Shell extends EventEmitter {
    constructor() { super(); this.webContents = new Contents(); this.contentView = { addChildView(view) { views.push(view); }, removeChildView() {} }; }
    maximize() {}
    async loadURL() {}
    isDestroyed() { return false; }
    getContentBounds() { return { width: 1200, height: 800 }; }
    focus() {}
    destroy() { this.emit("closed"); }
  }
  class View { constructor() { this.webContents = new Contents(); } setBounds(bounds) { this.bounds = bounds; layoutCount++; } setVisible(value) { this.visible = value; } }
  const ipcMain = { handle(_channel, callback) { handler = callback; }, removeHandler() {} };
  const electron = {
    BrowserWindow: Shell, WebContentsView: View, ipcMain,
    session: { fromPartition: () => ({ webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
  };
  let browser;
  const changed = [];
  const openTab = async (url) => {
    const tab = browser.createTab();
    tab.on("close", () => tab.destroy());
    await tab.loadURL(url);
    return tab;
  };
  const start = async () => {
    browser = await createProfileBrowser(electron, {
      name: "Тест", fp: { screen: { width: 1280, height: 720 } }, partition: "persist:test",
      openTab, closeProfile: async () => {}, show: false, onTabsChanged: () => changed.push(true),
    });
    browser.markReady();
    await openTab("https://one.example/");
    await openTab("https://two.example/");
    const event = { sender: browser.shell.webContents, senderFrame: browser.shell.webContents.mainFrame };
    return { browser, command: (message) => handler(event, message), stateEvents, changed, layoutCount: () => layoutCount };
  };
  return { start };
}

test("browser commands reorder tabs, preserve active tab and restore a closed tab", async () => {
  const h = await harness().start();
  let snapshot = h.browser.getTabSnapshot();
  assert.deepEqual(snapshot.tabs, ["https://one.example/", "https://two.example/"]);
  assert.equal(snapshot.activeIndex, 1);
  const latest = h.stateEvents.at(-1);
  const ids = latest.tabs.map((tab) => tab.id);
  await h.command({ action: "reorder-tabs", ids: [...ids].reverse() });
  snapshot = h.browser.getTabSnapshot();
  assert.deepEqual(snapshot.tabs, ["https://two.example/", "https://one.example/"]);
  assert.equal(snapshot.activeIndex, 0);
  await h.command({ action: "close-tab", id: ids[1] });
  assert.deepEqual(h.browser.getTabSnapshot().tabs, ["https://one.example/"]);
  assert.equal(h.stateEvents.at(-1).canRestoreTab, true);
  await h.command({ action: "reopen-closed" });
  assert.deepEqual(h.browser.getTabSnapshot().tabs, ["https://one.example/", "https://two.example/"]);
  assert.equal(h.browser.getTabSnapshot().activeIndex, 1);
  assert.ok(h.changed.length > 0);
  h.browser.destroy();
});

test("browser chrome keeps the secure shell height and rejects malformed tab orders", async () => {
  const h = await harness().start();
  assert.equal(CHROME_HEIGHT, 90);
  const result = await h.command({ action: "reorder-tabs", ids: ["unknown"] });
  assert.match(result.error, /Не удалось/);
  h.browser.destroy();
});

test("chrome height updates layout only after a real height change and never republishes state", async () => {
  const h = await harness().start();
  const stateCount = h.stateEvents.length;
  const layoutCount = h.layoutCount();
  await h.command({ action: "chrome-height", value: CHROME_HEIGHT });
  assert.equal(h.layoutCount(), layoutCount);
  assert.equal(h.stateEvents.length, stateCount);
  await h.command({ action: "chrome-height", value: CHROME_HEIGHT + 34 });
  assert.equal(h.layoutCount(), layoutCount + 2);
  assert.equal(h.stateEvents.length, stateCount);
  await h.command({ action: "chrome-height", value: CHROME_HEIGHT + 34 });
  assert.equal(h.layoutCount(), layoutCount + 2);
  assert.equal(h.stateEvents.length, stateCount);
  h.browser.destroy();
});