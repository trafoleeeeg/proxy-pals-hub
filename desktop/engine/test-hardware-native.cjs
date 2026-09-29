// Synthetic local fixtures: no preloads, debugger overrides, real profiles or
// external network. Only booleans leave a renderer; host identifiers stay local.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
assert.ok(process.env.UMBRA_NATIVE_HARDWARE_TEST_DIR);
app.setPath("userData", process.env.UMBRA_NATIVE_HARDWARE_TEST_DIR);
app.setPath("sessionData", path.join(process.env.UMBRA_NATIVE_HARDWARE_TEST_DIR, "sessions"));
app.enableSandbox();
app.commandLine.appendSwitch("disable-background-networking");
// These global flags must never contaminate sessions without a policy.
app.commandLine.appendSwitch("umbra-hardware-concurrency", "255");
app.commandLine.appendSwitch("umbra-device-memory", "0.25");
const presets = { a: { hardwareConcurrency: 3, deviceMemory: 0.5 }, b: { hardwareConcurrency: 11, deviceMemory: 2 } };
const windows = [];
let server;
const finish = code => {
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  server?.close();
  app.exit(code);
};
setTimeout(() => { console.error("UMBRA_NATIVE_HARDWARE_FAILED: timeout"); finish(1); }, 120000).unref();

function probe(p) {
  const proto = Object.getPrototypeOf(navigator);
  const cores = Object.getOwnPropertyDescriptor(proto, "hardwareConcurrency").get;
  const memory = Object.getOwnPropertyDescriptor(proto, "deviceMemory").get;
  return {
    cores: navigator.hardwareConcurrency === p.hardwareConcurrency,
    memory: navigator.deviceMemory === p.deviceMemory,
    getters: cores.call(navigator) === p.hardwareConcurrency && memory.call(navigator) === p.deviceMemory,
    native: [cores, memory].every(getter => Function.prototype.toString.call(getter).includes("[native code]")),
    noOwnOverrides: !Object.hasOwn(navigator, "hardwareConcurrency") && !Object.hasOwn(navigator, "deviceMemory"),
  };
}
function verify(value, label) {
  assert.ok(value && Object.keys(value).length === 5 && Object.values(value).every(item => item === true), label);
}
function restrict(ses, port) {
  ses.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url);
    done({ cancel: url.protocol !== "about:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === String(port)) });
  });
}
async function open(ses, url) {
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
    // Untrusted per-window additions must not replace session policy.
    additionalArguments: ["--umbra-hardware-concurrency=254", "-umbra-hardware-concurrency=253", "--umbra-device-memory=0.25", "/umbra-device-memory=4", "--UMBRA-DEVICE-MEMORY=1"] } });
  windows.push(win);
  await win.loadURL(url);
  return win;
}
async function verifyWindow(win) {
  const root = win.webContents.mainFrame;
  const child = root.frames[0];
  assert.ok(child && child.processId !== root.processId, "hardware fixture must exercise an OOPIF");
  for (const frame of [root, child]) {
    verify(await frame.executeJavaScript("firstHardware"), "first document script must see native policy");
    const workers = await frame.executeJavaScript("hardwareWorkers");
    for (const worker of workers) verify(worker, "first worker instruction must see native policy");
  }
}
app.whenReady().then(async () => {
  assert.equal(typeof session.defaultSession.setUmbraHardwareMetrics, "function", "native hardware API required");
  server = http.createServer((req, res) => {
    const [key, kind] = req.url.split("?")[0].split("/").filter(Boolean);
    const p = presets[key];
    if (!p) { res.setHeader("Content-Type", "text/html"); return res.end("<!doctype html>"); }
    const snapshot = `const firstHardware=(${probe.toString()})(${JSON.stringify(p)});`;
    if (kind?.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
      if (kind === "worker.js") return res.end(snapshot + "postMessage(firstHardware);");
      if (kind === "shared.js") return res.end(snapshot + "onconnect=e=>e.ports[0].postMessage(firstHardware);");
      return res.end(snapshot + "oninstall=()=>self.skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>e.ports[0].postMessage(firstHardware);");
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><script>${snapshot}
      const hardwareWorkers=Promise.all([
        new Promise((resolve,reject)=>{const w=new Worker('/${key}/worker.js');w.onmessage=e=>{resolve(e.data);w.terminate();};w.onerror=()=>reject(Error('dedicated worker failed'));}),
        new Promise((resolve,reject)=>{const w=new SharedWorker('/${key}/shared.js');w.port.onmessage=e=>resolve(e.data);w.onerror=()=>reject(Error('shared worker failed'));globalThis.keepWorker=w;}),
        navigator.serviceWorker.register('/${key}/sw.js').then(()=>navigator.serviceWorker.ready).then(reg=>new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=e=>resolve(e.data);reg.active.postMessage('probe',[c.port2]);}))
      ]);
      </script>${kind === "root" ? `<iframe src="http://localhost:${server.address().port}/${key}/child"></iframe>` : ""}`);
  });
  // The same origin on launch two exercises previously installed service
  // workers, not a fresh registration hidden behind a different random port.
  const portFile = path.join(process.env.UMBRA_NATIVE_HARDWARE_TEST_DIR, "fixture-port.json");
  let requestedPort = 0;
  try { requestedPort = JSON.parse(fs.readFileSync(portFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.ok(Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort < 65536);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(requestedPort, "127.0.0.1", resolve); });
  const port = server.address().port;
  fs.writeFileSync(portFile, JSON.stringify(port));
  const origin = `http://127.0.0.1:${port}`;
  const control = session.fromPartition("persist:hardware-control");
  restrict(control, port);
  const ordinary = await open(control, origin);
  // Keep real values inside this unconfigured renderer, never in diagnostics.
  assert.equal(await ordinary.webContents.executeJavaScript("globalThis.originalHardware={cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory}; ![253,254,255].includes(navigator.hardwareConcurrency)"), true, "unconfigured session must ignore injected arguments");
  assert.throws(() => control.setUmbraHardwareMetrics(presets.a), /before starting/);
  const entries = [];
  for (const [key, p] of Object.entries(presets)) {
    const ses = session.fromPartition(`persist:hardware-${key}`);
    restrict(ses, port);
    for (const bad of [{}, { ...p, hardwareConcurrency: 0 }, { ...p, hardwareConcurrency: 3.5 }, { ...p, hardwareConcurrency: 257 },
      { ...p, hardwareConcurrency: "3" }, { ...p, deviceMemory: 3 }, { ...p, deviceMemory: 16 }, { ...p, deviceMemory: "2" }, { ...p, deviceMemory: Infinity }]) {
      assert.throws(() => ses.setUmbraHardwareMetrics(bad), undefined, "reject invalid native policy");
    }
    ses.setUmbraHardwareMetrics(p);
    const win = await open(ses, `${origin}/${key}/root`);
    await verifyWindow(win);
    ses.setUmbraHardwareMetrics(p); // Reopening unchanged profile is valid.
    assert.throws(() => ses.setUmbraHardwareMetrics({ ...p, hardwareConcurrency: 7 }), /before starting/);
    entries.push({ ses, key, win });
  }
  for (const entry of entries) {
    await verifyWindow(entry.win); // Both differently configured sessions coexist.
    entry.win.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { show: false } }));
    const created = once(entry.win.webContents, "did-create-window");
    await entry.win.webContents.executeJavaScript(`void window.open('${origin}/${entry.key}/root')`, true);
    const [popup] = await created;
    windows.push(popup);
    if (popup.webContents.isLoading()) await once(popup.webContents, "did-finish-load");
    await verifyWindow(popup);
    popup.destroy();
    const gone = once(entry.win.webContents, "render-process-gone");
    entry.win.webContents.forcefullyCrashRenderer();
    await gone;
    await entry.win.loadURL(`${origin}/${entry.key}/root`);
    await verifyWindow(entry.win);
    entry.win.destroy();
    entry.win = await open(entry.ses, `${origin}/${entry.key}/root`);
    await verifyWindow(entry.win);
  }
  assert.equal(await ordinary.webContents.executeJavaScript("navigator.hardwareConcurrency === originalHardware.cores && navigator.deviceMemory === originalHardware.memory"), true, "configured sessions must not alter unconfigured hardware values");
  console.log("UMBRA_NATIVE_HARDWARE_OK");
  finish(0);
}).catch(error => { console.error("UMBRA_NATIVE_HARDWARE_FAILED: " + error.message); finish(1); });
