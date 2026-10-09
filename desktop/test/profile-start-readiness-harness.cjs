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
setTimeout(() => app.exit(1), 30000).unref();
app.whenReady().then(async () => {
  await initializeBackgroundWorkers();
  const fp = normalizeFingerprint({ os: "windows", languages: ["en-US"], timezone: "America/New_York", aggressivePrivacyMode: false }, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36");
  const partition = "persist:synthetic-start-readiness";
  const ses = session.fromPartition(partition);
  applyNativeHardwareMetrics(ses, fp, { required: process.platform === "win32" });
  applyNativeScreenMetrics(ses, fp, { required: process.platform === "win32" });
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("about:") }));
  const guard = await protectBackgroundWorkers(ses, fp, { onFailure: () => { console.error("WORKER_GUARD_FAILED"); app.exit(1); } });
  installSessionPrivacy(ses, fp, () => guard.isActive());
  browser = await createProfileBrowser(electron, { name: "Synthetic startup", partition, fp, show: false, openTab: async () => {}, closeProfile: async () => { throw new Error("Unexpected profile close"); } });
  let failures = 0;
  for (let index = 0; index < 8; index++) {
    const tab = browser.createTab({ pinnedHome: index === 0 });
    const wc = tab.webContents;
    wc.on("render-process-gone", () => { console.error("STARTUP_RENDERER_GONE"); app.exit(1); });
    // Fresh production WebContentsView: initialize blank before attaching CDP.
    await applyFingerprint(wc, fp, { onFailure: () => { failures++; console.error("PAGE_GUARD_FAILED"); } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(failures, 0);
    assert.equal(wc.isDestroyed(), false);
    console.log("SYNTHETIC_START_READY", index);
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
  const runtime = createProfileRuntime(runtimeElectron, { show: false,
    tabStore: { read: async () => ({ tabs: ["about:blank", "about:blank"], activeIndex: 0 }), write: async () => {} },
    bookmarkStore: { readState: async () => ({ bookmarks: [], barVisible: true, stored: true }), write: async () => {} },
  });
  let automaticClosures = 0;
  const id = "10000000-0000-4000-8000-000000000077";
  const launched = await runtime.launchProfileWindow({ profileId: id, name: "Synthetic full startup", proxy: null,
    cookies: "[]", lockToken: "synthetic-start-lease", fingerprint: fp }, () => { automaticClosures++; });
  assert.equal(launched.state, "running");
  assert.equal(launched.tabCount, 3, "home plus restored blank tabs");
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.equal(automaticClosures, 0, "the full production profile must not close itself");
  assert.equal(runtime.getRunningProfile(id).state, "running");
  await runtime.closeProfileWindow(id);
  console.log("UMBRA_START_READINESS_OK");
  app.exit(0);
}).catch(error => { console.error("UMBRA_START_READINESS_FAILED", error.message); browser?.destroy(); app.exit(1); });
