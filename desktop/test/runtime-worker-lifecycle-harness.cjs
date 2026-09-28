const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { initializeBackgroundWorkers, protectBackgroundWorkers, allowBackgroundWorkers } = require("../runtime/background-workers.cjs");
const { normalizeFingerprint, applyFingerprint, installSessionPrivacy } = require("../runtime/fingerprint.cjs");
const directory = process.env.UMBRA_WORKER_TEST_DIR;
assert.ok(directory);
const restart = process.env.UMBRA_WORKER_TEST_PHASE === "restart";
app.setPath("userData", path.join(directory, "user"));
app.setPath("sessionData", path.join(directory, "sessions"));
app.enableSandbox();
app.on("window-all-closed", () => {});
app.commandLine.appendSwitch("disable-background-networking");
const windows = new Set();
let server;
function finish(code) { for (const win of windows) if (!win.isDestroyed()) win.destroy(); server?.close(); app.exit(code); }
setTimeout(() => { console.error("WORKER_LIFECYCLE_TIMEOUT"); finish(1); }, 45000).unref();

async function identity() {
  // Capture synchronous properties before the script yields even once.
  const result = {
    ua: navigator.userAgent, platform: navigator.platform, languages: [...navigator.languages],
    cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    winter: new Date("2026-01-15T12:00:00Z").getTimezoneOffset(),
    summer: new Date("2026-07-15T12:00:00Z").getTimezoneOffset(),
  };
  result.hints = navigator.userAgentData && await navigator.userAgentData.getHighEntropyValues(["platformVersion", "architecture", "bitness", "uaFullVersion"]);
  result.headers = await fetch("/headers").then(r => r.json());
  return result;
}
const capture = `(${identity.toString()})()`;
function fingerprint(language, timezone, cores, memory) {
  return normalizeFingerprint({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36",
    os: "windows", osVersion: "11.0.0", languages: [language], timezone,
    hardwareConcurrency: cores, deviceMemory: memory, aggressivePrivacyMode: false });
}
const fpA = fingerprint("fr-CA", "America/Toronto", 6, 4);
const fpB = fingerprint("de-DE", "Asia/Tokyo", 10, 2);
const fpReopened = fingerprint("es-ES", "Europe/Madrid", 2, 8);
function check(value, fp, label) {
  for (const [field, expected] of Object.entries({ ua: fp.userAgent, platform: fp.platform, languages: fp.languages, cores: fp.hardwareConcurrency, memory: fp.deviceMemory, timezone: fp.timezone, locale: fp.languages[0] })) {
    assert.ok(JSON.stringify(value[field]) === JSON.stringify(expected), `${label}: ${field} must match this profile`);
  }
  const offsets = fp.timezone === "America/Toronto" ? [300, 240] : fp.timezone === "Asia/Tokyo" ? [-540, -540] : [-60, -120];
  assert.ok(value.winter === offsets[0] && value.summer === offsets[1], `${label}: native Date must follow timezone and DST`);
  assert.ok(value.hints?.platform === "Windows" && value.hints.platformVersion === "13.0.0" && value.hints.architecture === "x86" && value.hints.bitness === "64" && value.hints.uaFullVersion === fp.chromeVersion, `${label}: native Client Hints`);
  assert.ok(value.headers.ua === fp.userAgent && value.headers.language.startsWith(fp.languages[0]), `${label}: HTTP headers`);
}
app.whenReady().then(async () => {
  await initializeBackgroundWorkers();
  let port = restart ? JSON.parse(await fs.readFile(path.join(directory, "port.json"), "utf8")) : 0;
  server = http.createServer((req, res) => {
    if (req.url === "/headers") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ ua: req.headers["user-agent"], language: req.headers["accept-language"] })); }
    res.setHeader("Content-Type", "text/javascript");
    if (req.url === "/dedicated.js") return res.end(`${capture}.then(v=>postMessage(v));`);
    if (req.url === "/nested.js") return res.end(`const w=new Worker('/dedicated.js');w.onmessage=e=>postMessage(e.data);`);
    if (req.url.startsWith("/shared")) return res.end(`const first=${capture};onconnect=e=>{const p=e.ports[0];first.then(v=>p.postMessage(v));p.onmessage=()=>${capture}.then(v=>p.postMessage(v));p.start();};`);
    if (req.url.startsWith("/sw.js")) return res.end(`const first=${capture};oninstall=()=>skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onfetch=e=>{if(new URL(e.request.url).pathname==='/worker-state')e.respondWith(first.then(v=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}})));};onmessage=e=>first.then(v=>e.ports[0].postMessage(v));`);
    res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Worker lifecycle fixture</title>");
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  port = server.address().port;
  if (!restart) await fs.writeFile(path.join(directory, "port.json"), JSON.stringify(port));
  const origin = `http://127.0.0.1:${port}`;
  async function open(name, fp) {
    const ses = session.fromPartition("persist:worker-" + name);
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !["about:", "data:", "blob:"].some(p=>d.url.startsWith(p)) && !d.url.startsWith(origin + "/") }));
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setUserAgent(fp.userAgent, fp.languages.join(","));
    let fault, expectedFailure = false;
    const revoked = new Promise(resolve => { fault = resolve; });
    const protection = await protectBackgroundWorkers(ses, fp, { onFailure: message => {
      if (!expectedFailure) { console.error("UNEXPECTED_WORKER_PROTECTION_FAILURE"); finish(1); }
      fault(message);
    } });
    installSessionPrivacy(ses, fp, () => protection.isActive());
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    windows.add(win);
    await win.loadURL("about:blank");
    await applyFingerprint(win.webContents, fp, { onFailure: () => { console.error("PAGE_PROTECTION_FAILED"); finish(1); } });
    await win.loadURL(origin);
    return { ses, win, fp, protection, revoked, expectFailure: () => { expectedFailure = true; }, execute: source => win.webContents.executeJavaScript(source) };
  }
  const shared = p => p.execute("new Promise((resolve,reject)=>{const w=new SharedWorker('/shared.js');globalThis.fixturePort=w.port;w.port.onmessage=e=>resolve(e.data);w.onerror=()=>reject(new Error('shared failed'));w.port.start();})");
  const liveShared = p => p.execute("new Promise(resolve=>{fixturePort.onmessage=e=>resolve(e.data);fixturePort.postMessage('again');})");
  const service = p => p.execute("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(reg=>new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=e=>{resolve(e.data);c.port1.close();};reg.active.postMessage(0,[c.port2]);}))");
  async function close(p) { await p.protection.stop(); p.win.destroy(); windows.delete(p.win); await p.ses.cookies.flushStore(); p.ses.flushStorageData(); }
  let a = await open("a", restart ? fpReopened : fpA);
  check(await shared(a), a.fp, "A first shared");
  check(await service(a), a.fp, "A first service");
  const b = await open("b", fpB);
  check(await shared(b), b.fp, "B first shared");
  check(await service(b), b.fp, "B first service");
  check(await liveShared(a), a.fp, "A after B opened");
  check(await a.execute("new Promise((resolve,reject)=>{const w=new SharedWorker('/shared.js',{type:'module',name:'module'});w.onerror=()=>reject(new Error('module SharedWorker failed'));w.port.onmessage=e=>{resolve(e.data);w.port.close();};})"), a.fp, "module SharedWorker");
  check(await a.execute("new Promise((resolve,reject)=>{const w=new Worker('/nested.js');w.onerror=()=>reject(new Error('nested Worker failed'));w.onmessage=e=>{resolve(e.data);w.terminate();};})"), a.fp, "nested dedicated worker");
  check(await a.execute("(async()=>{const r=await navigator.serviceWorker.register('/sw.js?module',{type:'module',scope:'/module/'});const w=r.installing||r.waiting||r.active;if(w.state!=='activated')await new Promise(resolve=>w.onstatechange=()=>{if(w.state==='activated')resolve();});return new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=e=>{resolve(e.data);c.port1.close();};w.postMessage(0,[c.port2]);});})()"), a.fp, "module ServiceWorker");
  if (!restart) {
    await a.ses.cookies.set({ url: origin, name: "worker-fixture", value: "retained", expirationDate: Date.now()/1000+3600 });
    await a.execute("localStorage.setItem('worker-fixture','retained');caches.open('worker-fixture').then(c=>c.put('/fixture',new Response('retained')))");
    await close(a);
    check(await liveShared(b), b.fp, "B after A closed");
    a = await open("a", fpReopened);
    check(await shared(a), a.fp, "reopened A shared");
    // Do not re-register: use the already persisted registration/controller.
    check(await a.execute("fetch('/worker-state').then(r=>r.json())"), a.fp, "reopened A persisted service");
  } else {
    check(await a.execute("fetch('/worker-state').then(r=>r.json())"), a.fp, "restarted app persisted service");
  }
  assert.equal(await a.execute("localStorage.getItem('worker-fixture')"), "retained");
  assert.equal(await a.execute("caches.open('worker-fixture').then(c=>c.match('/fixture')).then(r=>r.text())"), "retained");
  assert.ok((await a.ses.cookies.get({ name: "worker-fixture" })).some(c=>c.value==='retained'));
  // An unexpected SW process loss is a protection failure, not permission to
  // resume an unguarded cached script. The other profile must remain usable.
  a.expectFailure();
  await a.win.webContents.debugger.sendCommand("ServiceWorker.enable");
  await a.win.webContents.debugger.sendCommand("ServiceWorker.stopAllWorkers");
  await a.revoked;
  assert.equal(a.protection.isActive(), false);
  assert.equal(await a.execute("fetch('/headers?after-failure').then(()=>false,()=>true)"), true);
  check(await liveShared(b), b.fp, "B after A protection failure");
  await close(a); await close(b);
  // Unprofiled panel sessions are explicitly registered and keep native APIs.
  const panel = session.fromPartition("worker-panel");
  await allowBackgroundWorkers(panel);
  console.log("UMBRA_WORKER_LIFECYCLE_OK: first-statement identity, simultaneous profiles, retained worker and storage, " + (restart ? "app restart" : "profile reopen"));
  finish(0);
}).catch(error => { console.error("WORKER_LIFECYCLE_FAILED", error.message); finish(1); });
