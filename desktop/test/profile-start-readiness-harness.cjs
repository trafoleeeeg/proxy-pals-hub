const electron = require("electron");
const { app, session } = electron;
const assert = require("node:assert/strict");
const path = require("node:path");
const { createProfileBrowser } = require("../runtime/browser.cjs");
const { applyFingerprint, normalizeFingerprint, applyNativeHardwareMetrics, applyNativeScreenMetrics, installSessionPrivacy } = require("../runtime/fingerprint.cjs");
const { initializeBackgroundWorkers, protectBackgroundWorkers } = require("../runtime/background-workers.cjs");
const { createProfileRuntime } = require("../runtime/profile-runtime.cjs");
assert.ok(process.env.UMBRA_START_TEST_DIR);
app.setPath("userData", path.join(process.env.UMBRA_START_TEST_DIR, "user"));
app.setPath("sessionData", path.join(process.env.UMBRA_START_TEST_DIR, "sessions"));
app.enableSandbox();
app.on("window-all-closed", () => {});
let browser;
let fixtureServer;
function probeNamedWorker(wc, workerType) {
  return wc.executeJavaScript(`new Promise((resolve, reject) => {
    const source = "postMessage({ cores: navigator.hardwareConcurrency, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });";
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { name: "synthetic-named-worker", type: ${JSON.stringify(workerType)} });
    const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error("Named worker did not resume")); }, 6000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); reject(new Error("Named worker script failed")); };
  })`, true);
}
setTimeout(() => app.exit(1), 30000).unref();
app.whenReady().then(async () => {
  await initializeBackgroundWorkers();
  const fp = normalizeFingerprint({ os: "windows", languages: ["en-US"], timezone: "America/New_York", aggressivePrivacyMode: false }, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36");
  const partition = "persist:synthetic-start-readiness";
  fixtureServer = require("node:http").createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>Synthetic worker fixture</title>"); });
  await new Promise(resolve => fixtureServer.listen(0, "127.0.0.1", resolve));
  fixtureServer.unref();
  const fixtureOrigin = "http://127.0.0.1:" + fixtureServer.address().port;
  const ses = session.fromPartition(partition);
  applyNativeHardwareMetrics(ses, fp, { required: process.platform === "win32" });
  applyNativeScreenMetrics(ses, fp, { required: process.platform === "win32" });
  // Local blob workers are part of this regression fixture; no external
  // navigation or network request is permitted.
  ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"] }, (details, callback) => callback({ cancel: new URL(details.url).origin !== fixtureOrigin }));
  const guard = await protectBackgroundWorkers(ses, fp, { onFailure: () => { console.error("WORKER_GUARD_FAILED"); app.exit(1); } });
  installSessionPrivacy(ses, fp, () => guard.isActive());
  browser = await createProfileBrowser(electron, { name: "Synthetic startup", partition, fp, show: false, openTab: async () => {}, closeProfile: async () => { throw new Error("Unexpected profile close"); } });
  let failures = 0;
  for (let index = 0; index < 8; index++) {
    const tab = browser.createTab({ pinnedHome: index === 0 });
    const wc = tab.webContents;
    wc.on("render-process-gone", () => { console.error("STARTUP_RENDERER_GONE"); app.exit(1); });
    // Fresh production WebContentsView: initialize blank before attaching CDP.
    await applyFingerprint(wc, fp, { onFailure: () => { failures++; console.error("PAGE_GUARD_FAILED"); app.exit(1); } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(failures, 0);
    assert.equal(wc.isDestroyed(), false);
    console.log("SYNTHETIC_START_READY", index);
    if (index === 7) {
      // Module workers require a non-opaque origin. Only this loopback fixture
      // is reachable, rather than weakening the network gate for real sites.
      await tab.loadURL(fixtureOrigin);
      for (const workerType of ["classic", "module"]) {
        const result = await probeNamedWorker(wc, workerType);
        assert.equal(result.cores, fp.hardwareConcurrency);
        assert.equal(result.language, fp.languages[0]);
        assert.equal(result.timezone, fp.timezone);
        assert.equal(failures, 0, "a valid named worker must not trigger a profile-wide stop");
        console.log("SYNTHETIC_NAMED_WORKER_READY", workerType);
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.equal(failures, 0);
  await guard.stop();
  browser.destroy();
  let runtimeElectron = electron;
  if (process.platform === "win32") {
    assert.equal(electron.safeStorage.isEncryptionAvailable(), true, "Windows startup must exercise real DPAPI");
  } else {
    // Linux CI has no OS keyring. This isolated fixture cipher is not an app
    // fallback; the mandatory Windows run continues to use real DPAPI.
    const crypto = require("node:crypto");
    const key = crypto.createHash("sha256").update("synthetic startup fixture only").digest();
    runtimeElectron = Object.create(electron);
    Object.defineProperty(runtimeElectron, "safeStorage", { value: {
      isEncryptionAvailable: () => true,
      encryptString(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
      decryptString(value) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
    } });
  }
  let runtimeBrowser;
  const runtime = createProfileRuntime(runtimeElectron, { show: false,
    createBrowser: async (...args) => { runtimeBrowser = await createProfileBrowser(...args); return runtimeBrowser; },
    tabStore: { read: async () => ({ tabs: ["about:blank", "about:blank"], activeIndex: 0 }), write: async () => {} },
    bookmarkStore: { readState: async () => ({ bookmarks: [], barVisible: true, stored: true }), write: async () => {} },
  });
  let automaticClosures = 0;
  const id = "10000000-0000-4000-8000-000000000077";
  const launched = await runtime.launchProfileWindow({ profileId: id, name: "Synthetic full startup", proxy: null,
    cookies: "[]", lockToken: "synthetic-start-lease", fingerprint: fp }, () => { automaticClosures++; });
  assert.equal(launched.state, "running");
  assert.equal(launched.tabCount, 3, "home plus restored blank tabs");
  const restoredContents = runtimeBrowser.shell.contentView.children.at(-1).webContents;
  await restoredContents.loadURL(fixtureOrigin);
  for (const workerType of ["classic", "module"]) {
    const result = await probeNamedWorker(restoredContents, workerType);
    assert.equal(result.cores, fp.hardwareConcurrency);
    assert.equal(result.language, fp.languages[0]);
    assert.equal(result.timezone, fp.timezone);
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.equal(automaticClosures, 0, "the full production profile must not close itself");
  assert.equal(runtime.getRunningProfile(id).state, "running");
  console.log("SYNTHETIC_FULL_PROFILE_NAMED_WORKERS_OK");
  await runtime.closeProfileWindow(id);
  console.log("UMBRA_START_READINESS_OK");
  fixtureServer.close();
  app.exit(0);
}).catch(error => { console.error("UMBRA_START_READINESS_FAILED", error.message); fixtureServer?.close(); browser?.destroy(); app.exit(1); });
