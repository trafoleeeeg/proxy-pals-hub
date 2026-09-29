// Synthetic loopback fixtures only. Never reads installed profiles or prints
// physical device identifiers. A real sandboxed renderer is mandatory.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { applyFingerprint, applyNativeScreenMetrics, normalizeFingerprint, installSessionPrivacy } = require("../runtime/fingerprint.cjs");
const { initializeBackgroundWorkers, protectBackgroundWorkers } = require("../runtime/background-workers.cjs");
const requireWindowsScreenEngine = process.platform === "win32" && process.env.UMBRA_REQUIRE_NATIVE === "1";
assert.ok(process.env.UMBRA_PRIVACY_TEST_DIR);
app.setPath("userData", path.join(process.env.UMBRA_PRIVACY_TEST_DIR, "user"));
app.setPath("sessionData", path.join(process.env.UMBRA_PRIVACY_TEST_DIR, "sessions"));
app.enableSandbox();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-quic");
const windows = [];
let server;
let failures = 0;
function finish(code) {
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  server?.close();
  app.exit(code);
}
setTimeout(() => { console.error("PRIVACY_TEST_TIMEOUT"); finish(1); }, 45000).unref();
async function probe() {
  const prototype = globalThis.Navigator?.prototype || WorkerNavigator.prototype;
  const canvas = globalThis.document ? document.createElement("canvas") : new OffscreenCanvas(20, 20);
  let canvasBlocked = false;
  try { canvas.getContext("2d").getImageData(0, 0, 1, 1); } catch (error) { canvasBlocked = error.name === "SecurityError"; }
  const gpuCanvas = globalThis.document ? document.createElement("canvas") : new OffscreenCanvas(20, 20);
  const hints = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "platformVersion", "uaFullVersion", "fullVersionList"]) : null;
  return {
    platform: navigator.platform, memory: navigator.deviceMemory, language: navigator.language,
    languages: [...navigator.languages], userAgent: navigator.userAgent, appVersion: navigator.appVersion,
    hardwareConcurrency: navigator.hardwareConcurrency, doNotTrack: navigator.doNotTrack,
    hints: hints && { brands: hints.brands, mobile: hints.mobile, platform: hints.platform, architecture: hints.architecture, bitness: hints.bitness, platformVersion: hints.platformVersion, uaFullVersion: hints.uaFullVersion, fullVersionList: hints.fullVersionList },
    prototypeMemory: Object.getOwnPropertyDescriptor(prototype, "deviceMemory").get.call(navigator),
    gpuBlocked: gpuCanvas.getContext("webgl") === null, webgpuBlocked: navigator.gpu === undefined, canvasBlocked,
    audioBlocked: typeof AudioContext === "undefined", sharedBlocked: typeof SharedWorker === "undefined", serviceBlocked: navigator.serviceWorker === undefined,
    dpr: globalThis.devicePixelRatio, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: globalThis.screen && { width: screen.width, height: screen.height },
    screenCss: globalThis.screen && {
      width: matchMedia(`(device-width: ${screen.width}px)`).matches,
      height: matchMedia(`(device-height: ${screen.height}px)`).matches,
      dpr: matchMedia(`(resolution: ${devicePixelRatio}dppx)`).matches,
    },
    firstScript: globalThis.firstIdentity || null,
    headers: await fetch("/headers").then((response) => response.json()),
  };
}
const probeSource = `(${probe.toString()})()`;
async function workerIdentity() {
  const initial = { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory };
  const hints = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(["architecture", "platformVersion", "uaFullVersion"]) : null;
  return {
    initial,
    userAgent: navigator.userAgent, platform: navigator.platform,
    language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
    hints: hints && { platform: hints.platform, platformVersion: hints.platformVersion, architecture: hints.architecture, uaFullVersion: hints.uaFullVersion },
  };
}
const workerIdentitySource = `(${workerIdentity.toString()})()`;
const firstScript = `<script>globalThis.firstIdentity={
  userAgent:navigator.userAgent, platform:navigator.platform, language:navigator.language,
  timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
  hardwareConcurrency:navigator.hardwareConcurrency, deviceMemory:navigator.deviceMemory,
  screenWidth:screen.width, screenHeight:screen.height, dpr:devicePixelRatio,
  cssWidth:matchMedia('(device-width: '+screen.width+'px)').matches,
  cssHeight:matchMedia('(device-height: '+screen.height+'px)').matches,
  cssDpr:matchMedia('(resolution: '+devicePixelRatio+'dppx)').matches
};<\/script>`;
app.whenReady().then(async () => {
  await initializeBackgroundWorkers();
  server = http.createServer((req, res) => {
    if (req.url === "/headers") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ ua: req.headers["user-agent"], language: req.headers["accept-language"], dnt: req.headers.dnt || null,
      brands: req.headers["sec-ch-ua"] || null, platform: req.headers["sec-ch-ua-platform"] || null, mobile: req.headers["sec-ch-ua-mobile"] || null })); }
    if (req.url === "/worker.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(`${probeSource}.then(result => postMessage(result));`); }
    if (req.url === "/shared.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(`const first=${workerIdentitySource};onconnect=e=>{first.then(result=>e.ports[0].postMessage(result));};`); }
    if (req.url === "/sw.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(`const first=${workerIdentitySource};self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>{first.then(result=>e.ports[0].postMessage(result));});`); }
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/frame"
      ? `<!doctype html>${firstScript}<script>${probeSource}.then(result=>parent.postMessage(result,'*'));<\/script>`
      : `<!doctype html><title>Privacy test</title>${firstScript}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const fp = normalizeFingerprint({ os: "macos", osVersion: "15.0.0", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/152.0.0.0", deviceMemory: 2, hardwareConcurrency: 10, languages: ["de-DE", "de"], timezone: "Asia/Tokyo", webrtc: "disabled" });
  async function open(origins = [], permissions = null, aggressivePrivacyMode = undefined, baseFingerprint = fp) {
    const identity = { ...baseFingerprint, hardwareOrigins: origins, ...(permissions ? { hardwarePermissions: permissions } : {}), ...(aggressivePrivacyMode === undefined ? {} : { aggressivePrivacyMode }) };
    const ses = session.fromPartition("privacy-fixture-" + randomUUID());
    // This must precede protectBackgroundWorkers: it creates a session-owned
    // guard view, after which the native screen policy cannot be installed.
    applyNativeScreenMetrics(ses, identity, { required: requireWindowsScreenEngine });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: !["about:", "data:", "blob:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname) });
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setUserAgent(identity.userAgent, identity.languages.join(","));
    installSessionPrivacy(ses, identity);
    await protectBackgroundWorkers(ses, identity, { onFailure: () => { console.error("BACKGROUND_PROTECTION_FAILED"); finish(1); } });
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    windows.push(win);
    win.webContents.on("render-process-gone", () => { console.error("PRIVACY_RENDERER_FAILED"); finish(1); });
    await win.loadURL("about:blank");
    await applyFingerprint(win.webContents, identity, { onFailure: () => { failures++; finish(1); } });
    await win.loadURL(origin);
    return win.webContents;
  }
  const strict = await open();
  const check = (result, frame = false) => {
    assert.equal(result.platform, "MacIntel"); assert.equal(result.memory, 2); assert.equal(result.prototypeMemory, 2);
    assert.equal(result.language, "de-DE"); assert.equal(result.timezone, "Asia/Tokyo");
    assert.equal(result.gpuBlocked, true); assert.equal(result.webgpuBlocked, true); assert.equal(result.canvasBlocked, true);
    assert.equal(result.audioBlocked, true); assert.equal(result.sharedBlocked, true); assert.equal(result.serviceBlocked, true);
    assert.equal(result.headers.ua, fp.userAgent); assert.match(result.headers.language, /^de-DE/);
    if (frame) assert.equal(result.dpr, 2);
  };
  check(await strict.executeJavaScript(probeSource), true);
  check(await strict.executeJavaScript("new Promise((resolve,reject)=>{const w=new Worker('/worker.js');w.onmessage=e=>{resolve(e.data);w.terminate();};w.onerror=reject;})"));
  async function crossFrame(wc) {
    return wc.executeJavaScript(`new Promise((resolve,reject)=>{const f=document.createElement('iframe');const timer=setTimeout(()=>reject(new Error('frame timeout')),8000);const listener=e=>{if(e.source!==f.contentWindow)return;clearTimeout(timer);window.removeEventListener('message',listener);resolve(e.data);};window.addEventListener('message',listener);f.src='http://localhost:${port}/frame';document.body.appendChild(f);})`);
  }
  check(await crossFrame(strict), true);
  assert.ok(strict.mainFrame.frames.some((frame) => frame.processId !== strict.mainFrame.processId), "fixture must exercise an OOPIF");
  const workersOnly = await open([], { [origin]: ["workers"] });
  const narrow = await workersOnly.executeJavaScript(probeSource);
  assert.equal(narrow.gpuBlocked, true); assert.equal(narrow.canvasBlocked, true); assert.equal(narrow.audioBlocked, true);
  assert.equal(narrow.sharedBlocked, false); assert.equal(narrow.serviceBlocked, false);
  assert.equal(await workersOnly.executeJavaScript("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)"), true);
  const compatible = await open([origin]);
  const relaxed = await compatible.executeJavaScript(probeSource);
  assert.equal(relaxed.canvasBlocked, false);
  assert.equal(relaxed.webgpuBlocked, false);
  assert.equal(relaxed.serviceBlocked, false);
  assert.equal(relaxed.sharedBlocked, false);
  assert.ok(await compatible.executeJavaScript("new Promise(resolve=>{const w=new SharedWorker('/shared.js');w.port.onmessage=e=>{resolve(e.data);w.port.close();};})"));
  assert.equal(await compatible.executeJavaScript("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)"), true);
  check(await crossFrame(compatible), true); // Parent consent never includes another origin.
  const normal = await open([], null, false);
  const ordinary = await normal.executeJavaScript(probeSource);
  assert.equal(ordinary.canvasBlocked, false);
  assert.equal(ordinary.audioBlocked, false);
  assert.equal(ordinary.sharedBlocked, false);
  assert.equal(ordinary.serviceBlocked, false);
  assert.ok(await normal.executeJavaScript("new Promise(resolve=>{const w=new SharedWorker('/shared.js');w.port.onmessage=e=>{resolve(e.data);w.port.close();};})"));
  assert.equal(await normal.executeJavaScript("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)"), true);
  const ordinaryFrame = await crossFrame(normal);
  assert.equal(ordinaryFrame.canvasBlocked, false);
  assert.equal(ordinaryFrame.audioBlocked, false);
  assert.equal(ordinaryFrame.sharedBlocked, false);
  assert.equal(ordinaryFrame.serviceBlocked, false);
  const windowsFp = normalizeFingerprint({
    os: "windows", osVersion: "11.0.0", architecture: "x86",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    languages: ["fr-CA", "fr"], timezone: "America/Toronto", hardwareConcurrency: 6,
    deviceMemory: 4, screen: { width: 1600, height: 900 }, doNotTrack: true,
  });
  const windowsProfile = await open([], null, false, windowsFp);
  const windowsMain = await windowsProfile.executeJavaScript(probeSource);
  const checkWindows = (result) => {
    assert.equal(result.platform, "Win32");
    assert.equal(result.memory, 4);
    assert.equal(result.hardwareConcurrency, 6);
    assert.equal(result.language, "fr-CA");
    assert.deepEqual(result.languages, ["fr-CA", "fr"]);
    assert.equal(result.timezone, "America/Toronto");
    assert.equal(result.userAgent, windowsFp.userAgent);
    assert.equal(result.appVersion, windowsFp.userAgent.replace(/^Mozilla\//, ""));
    assert.match(result.userAgent, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
    assert.equal(result.doNotTrack, "1");
    assert.equal(result.headers.ua, windowsFp.userAgent);
    assert.match(result.headers.language, /^fr-CA/);
    assert.equal(result.headers.dnt, "1");
    if (result.firstScript) {
      assert.equal(result.firstScript.userAgent, windowsFp.userAgent, "first inline script UA");
      assert.equal(result.firstScript.platform, "Win32", "first inline script OS");
      assert.equal(result.firstScript.language, "fr-CA", "first inline script locale");
      assert.equal(result.firstScript.timezone, "America/Toronto", "first inline script timezone");
      assert.equal(result.firstScript.hardwareConcurrency, 6, "first inline script CPU count");
      assert.equal(result.firstScript.deviceMemory, 4, "first inline script memory");
      assert.equal(result.firstScript.screenWidth, 1600, "first inline script screen width");
      assert.equal(result.firstScript.screenHeight, 900, "first inline script screen height");
      assert.equal(result.firstScript.dpr, 1, "first inline script DPR");
      if (requireWindowsScreenEngine) {
        assert.equal(result.firstScript.cssWidth, true, "first inline script CSS screen width");
        assert.equal(result.firstScript.cssHeight, true, "first inline script CSS screen height");
        assert.equal(result.firstScript.cssDpr, true, "first inline script CSS DPR");
      }
    }
    if (result.hints) {
      assert.equal(result.hints.platform, "Windows");
      assert.equal(result.hints.platformVersion, "13.0.0");
      assert.equal(result.hints.architecture, "x86");
      assert.equal(result.hints.bitness, "64");
      assert.equal(result.hints.uaFullVersion, windowsFp.chromeVersion);
      // Chromium may omit Client Hints entirely on this loopback HTTP fixture.
      // When sent, their low-entropy fields must match the JS identity.
      if (result.headers.brands !== null) assert.equal(result.headers.brands,
        result.hints.brands.map(({ brand, version }) => `${JSON.stringify(brand)};v=${JSON.stringify(version)}`).join(", "));
      if (result.headers.platform !== null) assert.equal(result.headers.platform, JSON.stringify(result.hints.platform));
      if (result.headers.mobile !== null) assert.equal(result.headers.mobile, result.hints.mobile ? "?1" : "?0");
      assert.deepEqual(result.hints.fullVersionList.map(({ brand, version }) => ({ brand, version })),
        result.hints.brands.map(({ brand }) => ({ brand, version: brand === "Not_A Brand" ? "99.0.0.0" : windowsFp.chromeVersion })));
    }
  };
  checkWindows(windowsMain);
  assert.ok(windowsMain.firstScript, "main document must report its first inline script identity");
  assert.deepEqual(windowsMain.screen, { width: 1600, height: 900 });
  assert.deepEqual(windowsMain.screenCss, { width: true, height: true, dpr: true });
  const windowsWorker = await windowsProfile.executeJavaScript("new Promise((resolve,reject)=>{const w=new Worker('/worker.js');w.onmessage=e=>{resolve(e.data);w.terminate();};w.onerror=reject;})");
  checkWindows(windowsWorker);
  assert.deepEqual(windowsWorker.hints, windowsMain.hints, "worker Client Hints must agree with the page");
  const windowsFrame = await crossFrame(windowsProfile);
  checkWindows(windowsFrame);
  assert.ok(windowsFrame.firstScript, "cross-origin iframe must report its first inline script identity");
  assert.deepEqual(windowsFrame.screen, windowsMain.screen, "cross-origin iframe screen must agree with the page");
  const oopifCssCoherent = Object.values(windowsFrame.screenCss).every(Boolean);
  // Stock Electron remains a documented limitation. The packaged test engine
  // must prove that real OOPIF CSS agrees with the document's JS values.
  if (requireWindowsScreenEngine) assert.equal(oopifCssCoherent, true, "native OOPIF CSS and JS screen must agree");
  console.log(`UMBRA_SCREEN_IDENTITY_AUDIT: main=true oopif=${oopifCssCoherent}`);
  const workerIdentityMatches = (result) => result.userAgent === windowsFp.userAgent && result.platform === "Win32" &&
    result.language === "fr-CA" && result.timezone === "America/Toronto" &&
    result.hardwareConcurrency === 6 && result.deviceMemory === 4 &&
    (!result.hints || (result.hints.platform === "Windows" && result.hints.platformVersion === "13.0.0" &&
      result.hints.architecture === "x86" && result.hints.uaFullVersion === windowsFp.chromeVersion));
  const sharedIdentity = await windowsProfile.executeJavaScript("new Promise((resolve,reject)=>{const w=new SharedWorker('/shared.js');const timer=setTimeout(()=>reject(new Error('shared worker timeout')),8000);w.port.onmessage=e=>{clearTimeout(timer);resolve(e.data);w.port.close();};w.onerror=reject;})");
  assert.equal(typeof sharedIdentity.userAgent, "string");
  const serviceIdentity = await windowsProfile.executeJavaScript("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(reg=>new Promise((resolve,reject)=>{const channel=new MessageChannel();const timer=setTimeout(()=>reject(new Error('service worker timeout')),8000);channel.port1.onmessage=e=>{clearTimeout(timer);resolve(e.data);channel.port1.close();};reg.active.postMessage('identity',[channel.port2]);}))");
  assert.equal(typeof serviceIdentity.userAgent, "string");
  // Both results must be true, including synchronous reads in the first
  // statement. Only booleans enter CI logs, never native device values.
  console.log(`UMBRA_WORKER_IDENTITY_AUDIT: shared=${workerIdentityMatches(sharedIdentity)} service=${workerIdentityMatches(serviceIdentity)}`);
  assert.equal(workerIdentityMatches(sharedIdentity), true, "SharedWorker identity");
  assert.equal(workerIdentityMatches(serviceIdentity), true, "ServiceWorker identity");
  assert.equal(workerIdentityMatches(sharedIdentity.initial), true, "SharedWorker must be protected before its first statement");
  assert.equal(workerIdentityMatches(serviceIdentity.initial), true, "ServiceWorker must be protected before its first statement");
  await compatible.executeJavaScript("document.cookie='synthetic=fixture; path=/'; localStorage.setItem('fixture','only-compatible'); true");
  assert.equal(await strict.executeJavaScript("document.cookie === '' && localStorage.getItem('fixture') === null"), true);
  assert.equal(failures, 0);
  console.log("UMBRA_PRIVACY_NATIVE_OK: strict page + worker + OOPIF; Windows identity matrix; normal mode; exact-origin exceptions; isolated storage");
  finish(0);
}).catch((error) => { console.error("UMBRA_PRIVACY_NATIVE_FAILED", error?.message || "unknown"); finish(1); });
