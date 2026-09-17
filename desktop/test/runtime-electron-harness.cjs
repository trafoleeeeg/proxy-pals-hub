// Invoked by runtime-electron.test.cjs, never against the application's userData.
if (process.versions.electron) {
  // Report callback exceptions instead of opening Electron's modal error dialog in CI.
  process.on("uncaughtException", (error) => {
    process.stdout.write(`UMBRA_NATIVE_TEST_FAILED ${error.name}: ${error.message}\n${error.stack}\n`);
    process.exit(1);
  });
  const electron = require("electron");
  const { app, session, net: electronNet, BrowserWindow, safeStorage } = electron;
  const path = require("node:path");
  const os = require("node:os");
  const fs = require("node:fs");
  const https = require("node:https");
  const http = require("node:http");
  const { X509Certificate, randomUUID } = require("node:crypto");
  const { Worker } = require("node:worker_threads");
  const assert = require("node:assert/strict");
  const { once } = require("node:events");
  const { createProfileRuntime } = require("../runtime/profile-runtime.cjs");
  const { applyFingerprint } = require("../runtime/fingerprint.cjs");
  const { createCookieStore } = require("../runtime/cookies.cjs");
  const { createRuntimeProxy } = require("../runtime/proxy.cjs");
  const { createProxyChecker, requestJson } = require("../runtime/proxy-probe.cjs");
  const { listen, mockSocks } = require("./runtime-proxy-fixtures.cjs");
  const directory = path.resolve(process.env.UMBRA_RUNTIME_TEST_DIR || ".");
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("umbra-electron-test-")) throw new Error("Dedicated temporary test directory required");
  app.setPath("userData", path.join(directory, "user-data"));
  app.setPath("sessionData", path.join(directory, "session-data"));
  app.disableHardwareAcceleration();
  if (process.env.UMBRA_NATIVE_DIAGNOSTIC === "1") {
    if (process.env.UMBRA_REQUIRE_NATIVE === "1" || process.env.UMBRA_REQUIRE_DPAPI === "1") throw new Error("Diagnostic mode cannot satisfy a required native test");
    app.commandLine.appendSwitch("no-sandbox");
  }
  // Some CI desktops cannot create a GPU subprocess; renderers stay sandboxed.
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-quic");
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("web-contents-created", (_event, wc) => {
    process.stdout.write(`NATIVE_CONTENT_CREATED ${wc.id}\n`);
    wc.on("did-finish-load", () => process.stdout.write(`NATIVE_CONTENT_LOADED ${wc.id}\n`));
    wc.on("render-process-gone", (_event, details) => {
      process.stdout.write(`NATIVE_RENDERER_EXIT ${JSON.stringify(details)}\n`);
      if (process.platform === "win32" && details.reason === "launch-failed" && details.exitCode === 49) {
        process.stdout.write("UMBRA_NATIVE_RENDERER_UNAVAILABLE: Windows sandbox account cannot launch a Chromium renderer\n");
        // app.exit can wait for proxy workers while Chromium is launching.
        process.exit(78);
      }
    });
    wc.on("preload-error", (_event, _file, error) => process.stdout.write(`NATIVE_PRELOAD_ERROR ${error.message}\n`));
  });
  const ID = "10000000-0000-4000-8000-000000000001";
  const SECOND = "10000000-0000-4000-8000-000000000002";
  const WRONG = "10000000-0000-4000-8000-000000000003";
  const certificate = { key: fs.readFileSync(path.join(directory, "localhost-key.pem")), cert: fs.readFileSync(path.join(directory, "localhost-cert.pem")) };
  const trusted = new X509Certificate(certificate.cert).fingerprint256;
  const cleanups = [];
  let runtime;
  function trustFixture(ses) {
    ses.setCertificateVerifyProc((request, callback) => {
      let matches = false;
      try { matches = new X509Certificate(request.certificate.data).fingerprint256 === trusted; } catch { /* Reject non-fixture certificates. */ }
      callback(matches && ["localhost", "fixture.test"].includes(request.hostname) ? 0 : -3);
    });
    return ses;
  }
  async function waitUntil(predicate) {
    for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
    throw new Error("Native fixture did not reach expected state");
  }

  app.whenReady().then(async () => {
    // Electron updates Chromium independently; keep the runtime gate format based
    // so a Dependabot security update is not rejected by a stale version literal.
    assert.match(process.versions.chrome, /^\d+\.\d+\.\d+\.\d+$/);
    const mode = process.env.UMBRA_RUNTIME_TEST_STORAGE;
    const memoryOnly = mode === "memory";
    if (mode === "native" && !safeStorage.isEncryptionAvailable()) {
      process.stdout.write("UMBRA_NATIVE_DPAPI_UNAVAILABLE: OS cookie encryption is unavailable\n");
      app.exit(77); return;
    }
    const records = new Map();
    const cookieStore = memoryOnly ? {
      read: async (id) => records.get(id),
      write: async (id, cookies, cookiesUpdatedAt) => { records.set(id, { cookies: structuredClone(cookies), cookiesUpdatedAt }); },
    } : createCookieStore({ safeStorage, userData: app.getPath("userData") });
    const { Server } = await import("proxy-chain");
    const hits = [];
    const origin = https.createServer(certificate, (req, res) => {
      hits.push({ path: req.url, ua: req.headers["user-agent"], language: req.headers["accept-language"], headers: req.headers });
      if (req.url === "/ip") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ ip: "203.0.113.8" })); }
      if (req.url === "/large") return res.end("x".repeat(100000));
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Accept-CH", "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version");
      res.end(`<html><head><title>Local fixture</title><script>globalThis.firstDocument={ua:navigator.userAgent,language:navigator.language,languages:[...navigator.languages],cores:navigator.hardwareConcurrency,width:screen.width,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date().getTimezoneOffset(),node:typeof require,bridge:typeof profileBrowser};</script></head><body><h1>Local fixture</h1><a href="/next">Next page</a></body></html>`);
    });
    const local = await listen(origin); cleanups.push(() => local.close());
    process.stdout.write("NATIVE_ORIGIN_READY\n");
    const httpHits = [];
    const plain = await listen(http.createServer((req, res) => { httpHits.push(req.url); res.setHeader("Content-Type", "text/html"); res.end("<title>HTTP fixture</title><h1>HTTP through proxy</h1>"); }));
    cleanups.push(() => plain.close());
    const auth = { a: 0, b: 0, rejected: 0 };
    const credentials = ({ username, password }) => {
      const valid = (username === "a" && password === "a-pass") || (username === "b" && password === "b-pass");
      if (valid) auth[username]++; else auth.rejected++;
      return { requestAuthentication: !valid };
    };
    const upstream = new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: credentials });
    await upstream.listen(); cleanups.push(() => upstream.close(true));
    process.stdout.write("NATIVE_PROXY_READY\n");
    const payload = (id = ID, username = "a") => ({
      profileId: id, name: "Native fixture", lockToken: `lock-${id}`,
      proxy: { protocol: "http", host: "127.0.0.1", port: upstream.port, username, password: `${username}-pass` },
      cookies: "[]", cookiesUpdatedAt: "2000-01-01T00:00:00.000Z", startUrl: `https://localhost:${local.port}/${id}`,
      fingerprint: { userAgent: "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", osVersion: "11.0", platform: "Win32", chromeVersion: "140.0.7339.81", languages: ["de-DE", "de"], timezone: "Asia/Tokyo", screen: { width: 1920, height: 1080, colorDepth: 24 }, hardwareConcurrency: 6, deviceMemory: 8, canvasNoise: 1327, audioNoise: 997 },
    });
    if (mode === "network") {
      const socks = await mockSocks(local.port); cleanups.push(() => socks.close());
      const checker = createProxyChecker({ net: electronNet, session: { fromPartition: (partition) => trustFixture(session.fromPartition(partition)) } }, { endpoints: [`https://localhost:${local.port}/ip`], timeoutMs: 2500 });
      for (const [password, expected] of [["a-pass", true], ["wrong", false]]) {
        const before = hits.length;
        const result = await checker({ ...payload().proxy, password });
        assert.equal(result.ok, expected);
        if (!expected) assert.equal(hits.length, before);
      }
      for (const [password, expected] of [["fixture-pass", true], ["wrong", false]]) {
        const before = hits.length;
        const result = await checker({ protocol: "socks5", host: "127.0.0.1", port: socks.port, username: "fixture-user", password });
        assert.equal(result.ok, expected);
        if (!expected) assert.equal(hits.length, before);
      }
      assert.equal(socks.observations.destinations[0].host, "localhost");
      const tlsProxy = new Server({ host: "127.0.0.1", port: 0, serverType: "https", httpsOptions: certificate, prepareRequestFunction: credentials });
      await tlsProxy.listen(); cleanups.push(() => tlsProxy.close(true));
      assert.equal((await checker({ protocol: "https", host: "localhost", port: tlsProxy.port, username: "a", password: "a-pass" })).ok, true);
      const workers = [];
      class TrackedWorker extends Worker { constructor(...args) { super(...args); workers.push(this); } }
      const crashSession = trustFixture(session.fromPartition(`crash-${randomUUID()}`));
      const bridge = await createRuntimeProxy(crashSession, payload().proxy, { WorkerClass: TrackedWorker });
      cleanups.push(() => bridge.dispose());
      assert.match(await (await crashSession.fetch(`http://127.0.0.1:${plain.port}/native-http`)).text(), /HTTP through proxy/);
      await requestJson(electronNet, crashSession, `https://localhost:${local.port}/ip`, 2500);
      const priorHits = hits.length;
      const exited = once(workers[0], "exit"); await workers[0].terminate(); await exited;
      await assert.rejects(requestJson(electronNet, crashSession, `https://localhost:${local.port}/ip`, 1000));
      assert.equal(hits.length, priorHits);
      assert.ok(bridge.diagnostics.failures > 0);
      return;
    }
    const closed = [];
    const { createExtensionStore } = require("../extensions.cjs");
    const extensionStore = createExtensionStore(() => app.getPath("userData"));
    const extensionSource = path.join(directory, "fixture-extension");
    fs.mkdirSync(extensionSource, { recursive: true });
    fs.writeFileSync(path.join(extensionSource, "manifest.json"), JSON.stringify({ name: "Fixture", version: "1.0", manifest_version: 3, content_scripts: [{ matches: ["https://localhost/*"], js: ["content.js"], run_at: "document_end" }] }));
    fs.writeFileSync(path.join(extensionSource, "content.js"), "document.documentElement.dataset.umbraExtension = 'loaded';");
    const extension = await extensionStore.addFromDirectory(extensionSource);
    runtime = createProfileRuntime(electron, { show: false, cookieStore, extensionStore, applyFingerprint: async (wc, fp) => {
      const send = wc.debugger.sendCommand.bind(wc.debugger);
      wc.debugger.sendCommand = async (...args) => {
        process.stdout.write(`NATIVE_CDP_START ${wc.id} ${args[0]}\n`);
        const result = await send(...args);
        process.stdout.write(`NATIVE_CDP_DONE ${wc.id} ${args[0]}\n`); return result;
      };
      return applyFingerprint(wc, fp);
    }, setupProxy: async (ses, proxy) => {
      const bridge = await createRuntimeProxy(trustFixture(ses), proxy);
      process.stdout.write("NATIVE_BRIDGE_READY\n"); return bridge;
    } });
    const profileShell = (ses) => BrowserWindow.getAllWindows().find((win) => win.contentView.children.some((view) => view.webContents?.session === ses));
    const profileTabs = (ses) => profileShell(ses)?.contentView.children.filter((view) => view.webContents?.session === ses) || [];
    const onClosed = (result) => {
      assert.ok(profileShell(session.fromPartition(`persist:profile-${result.profileId}`)));
      assert.equal(result.lockToken, `lock-${result.profileId}`);
      closed.push(result);
    };

    if (process.env.UMBRA_RUNTIME_TEST_PHASE === "restart") {
      const old = payload();
      old.cookies = JSON.stringify([{ name: "__Host-fixture", value: "stale-cloud", domain: "localhost", path: "/", hostOnly: true, secure: true, httpOnly: true, session: true }]);
      await runtime.launchProfileWindow(old, onClosed);
      const snapshot = await runtime.snapshotProfileCookies(ID);
      const restored = JSON.parse(snapshot.cookies).find((cookie) => cookie.name === "__Host-fixture");
      assert.equal(restored.value, "durable-local"); assert.equal(restored.session, true); assert.equal(restored.hostOnly, true);
      assert.equal(runtime.getRunningProfile(ID).diagnostics.cookieSource, "local");
      await runtime.closeAllProfiles();
      return;
    }

    const a = runtime.launchProfileWindow(payload(), onClosed);
    const duplicate = runtime.launchProfileWindow(payload(), onClosed);
    assert.strictEqual(a, duplicate);
    await Promise.all([a, runtime.launchProfileWindow(payload(SECOND, "b"), onClosed)]);
    assert.equal(runtime.listRunningProfiles().length, 2);
    assert.ok(auth.a > 0 && auth.b > 0);
    const ses = session.fromPartition(`persist:profile-${ID}`);
    const shell = profileShell(ses);
    const win = profileTabs(ses)[0];
    assert.equal(shell.isVisible(), false);
    assert.equal(await win.webContents.executeJavaScript("document.documentElement.dataset.umbraExtension"), "loaded");
    assert.equal(runtime.getRunningProfile(ID).diagnostics.extensions.loaded, 1);
    await extensionStore.remove(extension.id);
    assert.equal(await runtime.refreshExtensions(), 0);
    assert.equal(runtime.getRunningProfile(ID).diagnostics.extensions.loaded, 0);
    await extensionStore.addFromDirectory(extensionSource);
    assert.equal(await runtime.refreshExtensions(), 0);
    assert.equal(runtime.getRunningProfile(ID).diagnostics.extensions.loaded, 1);
    const first = await win.webContents.executeJavaScript("firstDocument");
    assert.ok(first.ua.includes(`Chrome/${process.versions.chrome}`));
    assert.ok(first.ua.includes("Windows NT 10.0"));
    assert.equal(first.language, "de-DE"); assert.equal(first.timezone, "Asia/Tokyo"); assert.equal(first.offset, -540);
    assert.equal(first.cores, 6); assert.equal(first.width, 1920); assert.equal(first.node, "undefined"); assert.equal(first.bridge, "undefined");
    const hints = await win.webContents.executeJavaScript("navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion'])");
    assert.equal(hints.fullVersionList.find((brand) => brand.brand === "Chromium").version, process.versions.chrome);
    assert.equal(hints.platformVersion, "13.0.0");
    const firstRequest = hits.find((hit) => hit.path === `/${ID}`);
    assert.equal(firstRequest.ua, first.ua); assert.ok(firstRequest.language.startsWith("de-DE"));
    assert.equal(win.webContents.getWebRTCIPHandlingPolicy(), "disable_non_proxied_udp");
    const preferences = win.webContents.getLastWebPreferences();
    assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false);
    assert.ok(!preferences.preload); assert.notEqual(shell.webContents.session, ses);
    const stableNoise = await win.webContents.executeJavaScript(`(() => {
      const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;
      const context=canvas.getContext('2d');context.fillStyle='rgb(100,100,100)';context.fillRect(0,0,40,40);
      const first=canvas.toDataURL();const second=canvas.toDataURL();
      const a=context.getImageData(0,0,40,40).data;const b=context.getImageData(0,0,40,40).data;
      const audio=new AudioBuffer({length:128,sampleRate:44100});const original=audio.getChannelData(0);original.fill(0.5);
      const copy1=new Float32Array(128),copy2=new Float32Array(128);audio.copyFromChannel(copy1,0);audio.copyFromChannel(copy2,0);
      return {canvas:first===second,pixels:a.every((value,i)=>value===b[i]),audio:copy1.every((value,i)=>value===copy2[i]),original:original.every(value=>value===0.5),changed:copy1[0]!==0.5};
    })()`);
    assert.deepEqual(stableNoise, { canvas: true, pixels: true, audio: true, original: true, changed: true });

    await ses.cookies.set({ url: `https://localhost:${local.port}/`, name: "__Host-fixture", value: "durable-local", path: "/", secure: true, httpOnly: true });
    const snapshot = await runtime.snapshotProfileCookies(ID);
    assert.equal(JSON.parse(snapshot.cookies).find((cookie) => cookie.name === "__Host-fixture").session, true);
    assert.equal((await runtime.snapshotProfileCookies(SECOND)).cookies.includes("durable-local"), false);
    if (!memoryOnly) {
      const encrypted = fs.readFileSync(path.join(app.getPath("userData"), "profile-cookie-snapshots", `${ID}.bin`));
      assert.equal(encrypted.includes(Buffer.from("durable-local")), false);
      assert.equal(JSON.parse(safeStorage.decryptString(encrypted)).profileId, ID);
    }

    await win.webContents.executeJavaScript(`window.open('https://localhost:${local.port}/popup')`, true);
    await waitUntil(() => runtime.getRunningProfile(ID).tabCount === 2);
    assert.equal(runtime.getRunningProfile(ID).windowCount, 1);
    const popup = profileTabs(ses).find((item) => item !== win);
    await waitUntil(() => popup.webContents.getURL().endsWith("/popup") && !popup.webContents.isLoading());
    assert.equal(shell.isVisible(), false);
    assert.equal(popup.webContents.getLastWebPreferences().preload, preferences.preload);
    assert.equal(popup.webContents.getWebRTCIPHandlingPolicy(), "disable_non_proxied_udp");
    assert.equal((await popup.webContents.executeJavaScript("firstDocument")).timezone, "Asia/Tokyo");

    await shell.webContents.executeJavaScript("document.getElementById('new').click()");
    try { await waitUntil(() => runtime.getRunningProfile(ID).tabCount === 3); }
    catch (failure) {
      const profile = runtime.getRunningProfile(ID);
      const toolbar = await shell.webContents.executeJavaScript("({bridge:typeof window.profileBrowser,ready:document.readyState,error:document.getElementById('error')?.textContent || '',tabs:document.querySelectorAll('#tabs .tab').length})").catch(() => null);
      throw new Error(`${failure.message}: ${JSON.stringify({ profile, toolbar })}`);
    }
    const fresh = profileTabs(ses).find((view) => view !== win && view !== popup);
    const freshContents = fresh.webContents;
    await waitUntil(() => !fresh.webContents.isLoading());
    const home = await shell.webContents.executeJavaScript("({hidden:document.getElementById('home').hidden,text:document.getElementById('home').textContent})");
    assert.equal(home.hidden, false);
    assert.match(home.text, /Asia\/Tokyo/);
    assert.match(home.text, /Показатели профиля/);
    assert.ok(!home.text.includes("a-pass") && !home.text.includes("lock-"));
    const navigateFromToolbar = (url) => shell.webContents.executeJavaScript(`(() => { const input = document.getElementById('address'); input.value = ${JSON.stringify(url)}; document.getElementById('navigate').requestSubmit(); })()`);
    await navigateFromToolbar(`http://127.0.0.1:${plain.port}/from-toolbar`);
    await waitUntil(() => httpHits.includes("/from-toolbar") && !fresh.webContents.isLoading());
    assert.ok(fresh.webContents.getURL().startsWith("http://127.0.0.1:"));
    assert.equal(await shell.webContents.executeJavaScript("document.getElementById('home').hidden"), true);
    await navigateFromToolbar(`http://127.0.0.1:${plain.port}/second-page`);
    await waitUntil(() => httpHits.includes("/second-page") && !fresh.webContents.isLoading());
    await shell.webContents.executeJavaScript("document.getElementById('back').click()");
    await waitUntil(() => fresh.webContents.getURL().endsWith("/from-toolbar") && !fresh.webContents.isLoading());
    await shell.webContents.executeJavaScript("document.getElementById('forward').click()");
    await waitUntil(() => fresh.webContents.getURL().endsWith("/second-page") && !fresh.webContents.isLoading());
    const beforeReload = httpHits.length;
    await shell.webContents.executeJavaScript("document.getElementById('reload').click()");
    await waitUntil(() => httpHits.length > beforeReload && !fresh.webContents.isLoading());
    await navigateFromToolbar("file:///C:/Windows/win.ini");
    await waitUntil(() => !fresh.webContents.isLoading());
    assert.ok(fresh.webContents.getURL().endsWith("/second-page"));
    await shell.webContents.executeJavaScript("document.querySelector('.tab:last-of-type .tab-close').click()");
    await waitUntil(() => runtime.getRunningProfile(ID).tabCount === 2);
    assert.equal(freshContents.isDestroyed(), true);
    assert.equal(runtime.getRunningProfile(ID).state, "running");

    const bad = payload(WRONG); bad.proxy.password = "wrong";
    await assert.rejects(runtime.launchProfileWindow(bad));
    assert.equal(hits.some((hit) => hit.path === `/${WRONG}`), false);

    await runtime.closeAllProfiles();
    assert.equal(closed.length, 2); assert.equal(BrowserWindow.getAllWindows().length, 0);
  }).then(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    process.stdout.write("UMBRA_NATIVE_TEST_OK\n"); app.exit(0);
  }).catch(async (error) => {
    process.stdout.write(`UMBRA_NATIVE_TEST_FAILED ${error.name}: ${error.message}\n${error.stack?.split("\n").slice(1, 3).join("\n")}\n`);
    if (runtime) await runtime.closeAllProfiles().catch(() => {});
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    app.exit(1);
  });
}
