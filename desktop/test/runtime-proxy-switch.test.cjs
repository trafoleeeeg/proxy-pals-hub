const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createProfileRuntime } = require("../runtime/profile-runtime.cjs");

const ID = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-00000000000a";
const B = "20000000-0000-4000-8000-00000000000b";
const FP = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0", languages: ["ru-RU"], timezone: "Europe/Moscow", hardwareConcurrency: 4, screen: { width: 1280, height: 800, colorDepth: 24 } };

const proxies = () => ([
  { id: A, label: "Первый", protocol: "http", host: "10.0.0.1", port: 8080, username: "user", password: "secret-a", country: "DE", city: "Berlin" },
  { id: B, label: "Второй", protocol: "socks5", host: "10.0.0.2", port: 1080, username: null, password: "secret-b", country: "NL", city: "" },
]);

function harness(options = {}) {
  const windows = [];
  let reloads = 0;
  let resourceError;
  const setups = [];
  const settings = [];
  let browserOptions;
  class Window extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        id: windows.length + 1,
        setUserAgent() {}, setWebRTCIPHandlingPolicy() {}, getWebRTCIPHandlingPolicy: () => "disable_non_proxied_udp", setWindowOpenHandler() {},
        stop() {}, setZoomLevel() {}, getURL: () => this.url || "", reload: () => { reloads++; },
      });
      this.webContents.debugger = new EventEmitter();
      Object.assign(this.webContents.debugger, { attach() {}, isAttached: () => true, detach() {}, sendCommand: async () => {} });
      windows.push(this);
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const electron = {
    BrowserWindow: Window,
    app: { getPath: () => "." },
    session: { fromPartition() {
      const cookies = new EventEmitter();
      Object.assign(cookies, { get: async () => [], set: async () => {}, flushStore: async () => {} });
      return { cookies, webRequest: { onBeforeRequest() {}, onErrorOccurred(_filter, handler) { resourceError = typeof _filter === "object" ? handler : null; } }, getUserAgent: () => "Chrome/144.0.0.0", setUserAgent() {},
        flushStorageData() {}, closeAllConnections: async () => {}, clearStorageData: async () => {},
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {} };
    } },
  };
  const runtime = createProfileRuntime(electron, {
    createBrowser: async (_electron, opts) => { browserOptions = opts; return { shell: { isDestroyed: () => false, focus() {} }, destroy() {}, publish() {}, markReady() {}, createTab: () => new Window() }; },
    setupProxy: async (_ses, proxy) => {
      setups.push(proxy);
      if (options.failProxy && proxy && proxy.host === options.failProxy) throw new Error("Proxy setup failed; traffic is blocked");
      return { diagnostics: { mode: "http" }, dispose: async () => {} };
    },
    checkProxy: options.checkProxy,
    cookieStore: { read: async () => null, write: async () => {} },
    tabStore: { read: async () => ({ tabs: [], activeIndex: 0 }), write: async () => {} },
    bookmarkStore: { readState: async () => ({ bookmarks: [], barVisible: true, stored: true }), write: async (_id, state) => structuredClone(state) },
    onBrowserSettingsChanged: (value) => settings.push(value),
  });
  return { runtime, setups, settings, options: () => browserOptions, reloads: () => reloads,
    pageId: () => windows.find((win) => win.url === "https://google.com/")?.webContents.id,
    failResource: (details) => resourceError?.(details) };
}

const payload = (extra = {}) => ({ profileId: ID, deviceId: "test-device", name: "Test", lockToken: "t", fingerprint: FP,
  cookies: "[]", cookiesUpdatedAt: null, proxy: { protocol: "http", host: "10.0.0.1", port: 8080, username: "user", password: "secret-a" },
  proxies: proxies(), startUrl: "about:blank", ...extra });

test("сбой сохранённого прокси никогда не включает прямой интернет при запуске", async () => {
  const h = harness({ failProxy: "10.0.0.2" });
  await assert.rejects(h.runtime.launchProfileWindow(payload({ proxy: null, browserSettings: {
    profileId: ID, bookmarks: [], bookmarkBarVisible: true, zoomLevel: 0, extensions: [],
    activeProxyId: B, proxyFailover: false, revision: 1,
  } })), /Не удалось поднять прокси/);
  assert.equal(h.setups.length, 1);
  assert.equal(h.setups[0].host, "10.0.0.2");
  assert.equal(h.runtime.listRunningProfiles().length, 0);
});

test("сбой сохранённого прокси допускает только другой настроенный прокси", async () => {
  const h = harness({ failProxy: "10.0.0.2" });
  await h.runtime.launchProfileWindow(payload({ browserSettings: {
    profileId: ID, bookmarks: [], bookmarkBarVisible: true, zoomLevel: 0, extensions: [],
    activeProxyId: B, proxyFailover: false, revision: 1,
  } }));
  assert.deepEqual(h.setups.map((proxy) => proxy.host), ["10.0.0.2", "10.0.0.1"]);
  await h.runtime.closeAllProfiles();
});

test("окно профиля получает список прокси без паролей и переключается на выбранный сервер", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload({ startUrl: "https://google.com/" }));
  const list = h.options().getProxies();
  assert.equal(list.length, 2);
  assert.equal(JSON.stringify(list).includes("secret"), false);
  assert.equal(list[0].active, true);
  await h.options().switchProxy(B);
  assert.equal(h.setups.at(-1).host, "10.0.0.2");
  assert.equal(h.options().getProxies()[1].active, true);
  assert.equal(h.settings.at(-1).activeProxyId, B);
  assert.equal(h.reloads(), 1, "страница должна повторно запросить отменённые ресурсы через новый прокси");
  await h.runtime.closeProfileWindow(ID);
});

test("сбой нового прокси возвращает профиль на прежний сервер", async () => {
  const h = harness({ failProxy: "10.0.0.2" });
  await h.runtime.launchProfileWindow(payload({ startUrl: "https://google.com/" }));
  await assert.rejects(h.options().switchProxy(B), /Не удалось переключить прокси/);
  assert.equal(h.setups.at(-1).host, "10.0.0.1");
  assert.equal(h.options().getProxies()[0].active, true);
  assert.equal(h.reloads(), 1, "после возврата старого прокси страница должна восстановить отменённые ресурсы");
  await h.runtime.closeProfileWindow(ID);
});

test("автопереключение обходит нерабочий сервер, когда оно включено", async () => {
  const h = harness({ checkProxy: async (proxy) => (proxy.host === "10.0.0.2" ? { ok: true, ip: "203.0.113.9", latency: 120 } : { ok: false }) });
  await h.runtime.launchProfileWindow(payload({ browserSettings: {
    profileId: ID, bookmarks: [], bookmarkBarVisible: true, zoomLevel: 0, extensions: [],
    activeProxyId: A, proxyFailover: true, revision: 3,
  } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.options().getProxies()[1].active, true, "профиль должен перейти на рабочий сервер");
  await h.runtime.closeProfileWindow(ID);
});

test("облачные настройки восстанавливают выбранный прокси и автопереключение", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload({ browserSettings: {
    profileId: ID, bookmarks: [], bookmarkBarVisible: true, zoomLevel: 0, extensions: [],
    activeProxyId: B, proxyFailover: true, revision: 2,
  } }));
  assert.equal(h.setups[0].host, "10.0.0.2");
  assert.equal(h.options().getProxyFailover(), true);
  await h.runtime.closeProfileWindow(ID);
});

test("серия сетевых сбоев ресурсов восстанавливает изображения и стили страницы", async () => {
  const h = harness();
  await h.runtime.launchProfileWindow(payload({ startUrl: "https://google.com/" }));
  const pageId = h.pageId();
  h.failResource({ webContentsId: pageId, resourceType: "image", error: "net::ERR_CONNECTION_RESET" });
  h.failResource({ webContentsId: pageId, resourceType: "stylesheet", error: "net::ERR_TIMED_OUT" });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(h.reloads(), 1, "повреждённая страница должна загрузиться заново");
  h.failResource({ webContentsId: pageId, resourceType: "image", error: "net::ERR_BLOCKED_BY_CLIENT" });
  h.failResource({ webContentsId: pageId, resourceType: "image", error: "net::ERR_BLOCKED_BY_CLIENT" });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(h.reloads(), 1, "намеренную блокировку расширением нельзя превращать в цикл перезагрузки");
  await h.runtime.closeProfileWindow(ID);
});
