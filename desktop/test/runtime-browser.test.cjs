const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createProfileBrowser, CHROME_HEIGHT } = require("../runtime/browser.cjs");
const { browserUrl } = require("../runtime/browser-ui.cjs");

function harness() {
  let handler;
  const stateEvents = [];
  const views = [];
  let layoutCount = 0;
  let bookmarks = [];
  const importedCookies = [];
  let extensions = [{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Тест", version: "1.0", pinned: false }];
  class Contents extends EventEmitter {
    constructor() {
      super(); this.url = "about:blank"; this.title = ""; this.loading = false;
      this.session = { fetch: async () => { throw new Error("offline fixture"); } };
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
      this.mainFrame = {};
    }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    getZoomLevel() { return this.zoomLevel || 0; }
    setZoomLevel(level) { this.zoomLevel = level; }
    isLoading() { return this.loading; }
    isDestroyed() { return false; }
    async loadURL(url) { this.url = url; this.title = url === "about:blank" ? "" : new URL(url).hostname; this.emit("did-navigate", {}, url); }
    reload() {}
    async capturePage() { return { isEmpty: () => false, toDataURL: () => "data:image/png;base64,AA==" }; }
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
      getBookmarks: () => bookmarks,
      getExtensions: () => extensions,
      importCookies: async (text) => { importedCookies.push(text); return { imported: 2, skipped: 1 }; },
      setExtensionPinned: async (id, pinned) => { extensions = extensions.map((item) => item.id === id ? { ...item, pinned } : item); },
      addBookmark: async (bookmark) => { bookmarks = [...bookmarks, { id: "11111111-1111-4111-8111-111111111111", ...bookmark }]; },
    });
    browser.markReady();
    await openTab("https://one.example/");
    await openTab("https://two.example/");
    const event = { sender: browser.shell.webContents, senderFrame: browser.shell.webContents.mainFrame };
    return { browser, command: (message) => handler(event, message), stateEvents, changed, views, getBookmarks: () => bookmarks, importedCookies, layoutCount: () => layoutCount };
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

test("browser imports cookie text through the serialized profile command", async () => {
  const h = await harness().start();
  const result = await h.command({ action: "import-cookies", text: '[{"name":"session"}]' });
  assert.deepEqual(result, { imported: 2, skipped: 1 });
  assert.deepEqual(h.importedCookies, ['[{"name":"session"}]']);
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

test("browser UI sends chrome height only when it changes", () => {
  const source = decodeURIComponent(browserUrl().split(",", 2)[1]);
  assert.match(source, /if \(height === sentChromeHeight\) return;/);
});

test("saving the current page passes its fetched favicon to the bookmark store", async () => {
  const h = await harness().start();
  const favicon = Buffer.from("favicon fixture");
  const contents = h.views.at(-1).webContents;
  contents.session.fetch = async () => ({
    headers: { get: () => "image/png" },
    arrayBuffer: async () => favicon,
  });
  contents.emit("page-favicon-updated", {}, ["https://two.example/favicon.png"]);
  await new Promise((resolve) => setImmediate(resolve));
  await h.command({ action: "bookmark" });
  assert.equal(h.getBookmarks()[0].favicon, `data:image/png;base64,${favicon.toString("base64")}`);
  h.browser.destroy();
});

test("browser publishes zoom percentage and hides the page behind bookmark manager", async () => {
  const h = await harness().start();
  assert.equal(h.stateEvents.at(-1).zoomPercent, 100);
  await h.command({ action: "zoom-in" });
  assert.equal(h.stateEvents.at(-1).zoomPercent, 110);
  await h.command({ action: "show-bookmarks" });
  assert.equal(h.stateEvents.at(-1).bookmarksOpen, true);
  assert.equal(h.views.at(-1).visible, false);
  await h.command({ action: "hide-bookmarks" });
  assert.equal(h.stateEvents.at(-1).bookmarksOpen, false);
  assert.equal(h.views.at(-1).visible, true);
  h.browser.destroy();
});

test("shell popovers show over a page snapshot instead of pushing the page down", async () => {
  const h = await harness().start();
  await h.command({ action: "overlay", value: true });
  assert.equal(h.views.at(-1).bounds.y, CHROME_HEIGHT);
  assert.equal(h.views.at(-1).visible, false);
  assert.equal(h.stateEvents.at(-1).overlay, true);
  assert.match(h.stateEvents.at(-1).pageSnapshot, /^data:image\/png;base64,/);
  await h.command({ action: "pin-extension", id: "aaaaaaaaaaaaaaaaaaaaaaaa", pinned: true });
  assert.equal(h.stateEvents.at(-1).extensions[0].pinned, true);
  await h.command({ action: "overlay", value: false });
  assert.equal(h.views.at(-1).bounds.y, CHROME_HEIGHT);
  assert.equal(h.views.at(-1).visible, true);
  assert.equal(h.stateEvents.at(-1).pageSnapshot, "");
  h.browser.destroy();
});

test("browser resolves a host in advance for the address bar", async () => {
  const h = await harness().start();
  await h.command({ action: "preconnect", host: "example.com" });
  assert.equal(h.stateEvents.at(-1).overlay, false);
  h.browser.destroy();
});

test("browser UI contains a dedicated bookmark manager, search and compact zoom controls", () => {
  const source = decodeURIComponent(browserUrl().split(",", 2)[1]);
  assert.match(source, /id="bookmarks-button"/);
  assert.match(source, /id="manager-search"/);
  assert.match(source, /id="zoom-value"/);
  assert.match(source, /action: "show-bookmarks"/);
  assert.match(source, /id="pinned-extensions"/);
  assert.match(source, /action: "overlay"/);
  assert.match(source, /id="page-snapshot"/);
  assert.match(source, /action: "preconnect"/);
  assert.match(source, /action: "pin-extension"/);
  assert.match(source, /id="cookie-file"/);
  assert.match(source, /data-local="cookie-import"/);
  assert.match(source, /action: "import-cookies"/);
});

test("browser keeps quick tab actions outside the slow command queue", () => {
  const source = require("node:fs").readFileSync(require.resolve("../runtime/browser.cjs"), "utf8");
  assert.match(source, /const SERIALIZED = new Set\(\[/);
  assert.match(source, /if \(!SERIALIZED\.has\(message\?\.action\)\) return runCommand\(message\);/);
  for (const action of ["close-tab", "navigate", "back", "forward", "reload", "new", "select", "duplicate", "find"]) {
    assert.ok(!new RegExp(`"${action}",`).test(source.slice(source.indexOf("const SERIALIZED"), source.indexOf("function runCommand"))),
      `команда ${action} не должна попадать в очередь`);
  }
  assert.match(source, /popup\.show\(\);\s*popup\.focus\(\);/);
  assert.match(source, /refitExtensionPopup\(popup\)/);
});

test("profile tabs apply fingerprint without a preliminary about:blank load", () => {
  const source = require("node:fs").readFileSync(require.resolve("../runtime/profile-runtime.cjs"), "utf8");
  const block = source.slice(source.indexOf("async function makeWindow"), source.indexOf("function launchProfileWindow"));
  assert.match(block, /const fingerprintAttempt = configureFingerprint\(win\.webContents, entry\.fp\)/);
  assert.match(block, /Promise\.race\(\[\s*fingerprintAttempt/);
  assert.ok(block.indexOf("configureFingerprint") < block.indexOf('await navigate(win, "about:blank")'),
    "отпечаток должен применяться до запасной загрузки about:blank");
  assert.match(block, /win\.webContents\.loadURL\("about:blank"\)\.catch/);
  assert.ok(!/await\s+win\.webContents\.loadURL\("about:blank"\)/.test(block),
    "запуск пустой страницы не должен ожидаться перед отпечатком");
  assert.match(source, /await Promise\.all\(plan\.slice\(1\)\.map/);
});

test("canvas fingerprint protection never rewrites large visual canvases", () => {
  const source = require("node:fs").readFileSync(require.resolve("../fingerprint-preload.cjs"), "utf8");
  assert.match(source, /width \* height > 262144/);
  assert.match(source, /index \+= 4093/);
  assert.ok(!source.includes("index += 128"), "плотный шум создаёт видимые полосы на содержимом сайтов");
});
