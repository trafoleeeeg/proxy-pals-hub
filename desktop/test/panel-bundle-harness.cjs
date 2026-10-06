const electron = require("electron");
const { app, BrowserWindow, session, ipcMain, safeStorage } = electron;
const assert = require("node:assert/strict");
const path = require("node:path");
const { createPanelBundle, loadBundled } = require("../runtime/panel-bundle.cjs");
const { createPanelStartup } = require("../runtime/panel-startup.cjs");
app.setPath("userData", process.env.UMBRA_STARTUP_TEST_DIR);
app.enableSandbox();
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("in-process-gpu");
app.whenReady().then(async () => {
  const started = performance.now();
  const origin = "https://proxy-pals-hub.lovable.app";
  const panelSession = session.fromPartition("isolated-local-panel-test");
  let ready = false; let localResources = 0; let serverCalls = 0;
  ipcMain.handle("umbra:panel-ready", () => { ready = true; return { ok: true }; });
  const bundle = createPanelBundle({ origin, bundledDirectory: path.join(__dirname, "../.panel"),
    cacheDirectory: path.join(app.getPath("userData"), "cache"), safeStorage: null,
    panelSession: { protocol: panelSession.protocol, fetch: async () => { serverCalls++; return new Response(null, { status: 503 }); } },
  });
  // No real request, login, cookies or employee/owner session is used.
  panelSession.protocol.unhandle("https");
  panelSession.protocol.handle("https", request => { localResources++; return bundle.handler(request); });
  const window = new BrowserWindow({ show: false, webPreferences: { session: panelSession,
    preload: path.join(__dirname, "../preload.cjs"), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  // Production shows its owner window before loading the panel. Xvfb correctly
  // suspends rAF in a hidden window: exercise an actual paint, without focus.
  window.showInactive();
  const errors = [];
  window.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  await window.loadURL(origin + "/app");
  const firstDocumentMs = Math.round(performance.now() - started);
  for (let n = 0; n < 100; n++) {
    if (await window.webContents.executeJavaScript("!!document.querySelector('input#email')")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await window.webContents.executeJavaScript("!!document.querySelector('input#email')"), true, "Local SPA hydrates and redirects unsigned user to login: " + errors.join("; "));
  assert.equal(await window.webContents.executeJavaScript("typeof window.umbra?.panelReady"), "function", "Trusted origin and sandbox preload remain intact");
  // The login form can commit before the two compositor frames required by
  // notifyPanelPainted, especially under Xvfb. Wait for the real IPC assertion.
  for (let n = 0; n < 100 && !ready; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(ready, true, "Real local UI sends paint-ready IPC");
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  assert(localResources > 3);
  assert.equal(serverCalls, 0, "Cold anonymous UI works without network");
  // Reload the auth page and another protected section under the same origin.
  await window.loadURL(origin + "/app/proxies");
  for (let n = 0; n < 100; n++) {
    if (await window.webContents.executeJavaScript("!!document.querySelector('input#email')")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await window.webContents.executeJavaScript("!!document.querySelector('input#email')"), true);

  // A synthetic persisted session makes server verification wait. Its local
  // user must not unlock protected UI, nor keep the startup overlay visible.
  const publicBundle = loadBundled(path.join(__dirname, "../.panel"));
  const project = [...publicBundle.bytes.values()].map(bytes => bytes.toString()).join("\n").match(/https:\/\/([a-z0-9-]+)\.supabase\.co/);
  assert(project, "Public Supabase project configuration is present in client bundle");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: "00000000-0000-4000-8000-000000000001", exp: expires })).toString("base64url") + ".synthetic-signature";
  const synthetic = { access_token: token, refresh_token: "synthetic-fixture-only", token_type: "bearer", expires_in: 3600, expires_at: expires,
    user: { id: "00000000-0000-4000-8000-000000000001", email: "fixture-only@example.test", app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: new Date().toISOString() } };
  const authSession = session.fromPartition("isolated-local-panel-pending-test");
  let release; let blockedCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const pendingBundle = createPanelBundle({ origin, bundledDirectory: path.join(__dirname, "../.panel"),
    cacheDirectory: path.join(app.getPath("userData"), "unused-cache"), safeStorage: null,
    panelSession: { protocol: authSession.protocol, fetch: async () => { blockedCalls++; await gate; return new Response(null, { status: 503 }); } },
  });
  authSession.protocol.unhandle("https");
  authSession.protocol.handle("https", async request => new URL(request.url).pathname === "/fixture-bootstrap"
    ? new Response("<!doctype html><script>localStorage.setItem(" + JSON.stringify(`sb-${project[1]}-auth-token`) + ", " + JSON.stringify(JSON.stringify(synthetic)) + ")</script>", { headers: { "Content-Type": "text/html" } })
    : pendingBundle.handler(request));
  const pendingWindow = new BrowserWindow({ show: false, webPreferences: { session: authSession,
    preload: path.join(__dirname, "../preload.cjs"), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await pendingWindow.loadURL(origin + "/fixture-bootstrap");
  const pendingStarted = performance.now();
  const startup = createPanelStartup(electron, pendingWindow, { appUrl: origin + "/app", version: "fixture", localPanel: () => true,
    showError: async () => { throw new Error("Unexpected local panel navigation failure"); } });
  // Keep the automated fixture invisible; production still shows its one window.
  pendingWindow.hide();
  await startup.start();
  const pendingDocumentMs = Math.round(performance.now() - pendingStarted);
  assert.equal(startup.state().disposed, true, "Server auth must not hold local first paint hostage");
  for (let n = 0; n < 40 && blockedCalls === 0; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert(blockedCalls > 0, "Synthetic persisted identity is checked with the server");
  const text = await pendingWindow.webContents.executeJavaScript("document.body.innerText");
  assert(text.includes("Проверяем сессию"));
  assert(!text.includes(synthetic.user.email), "Stored identity never appears before verification");
  release(); pendingWindow.destroy();

  const osProtection = safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  if (process.env.UMBRA_REQUIRE_DPAPI === "1") assert(osProtection, "Windows OS cache protection must be available");
  if (osProtection) {
    const nextManifest = { ...publicBundle.manifest, revision: new Date(Date.parse(publicBundle.manifest.revision) + 1000).toISOString() };
    const updateOptions = { origin, bundledDirectory: path.join(__dirname, "../.panel"),
      cacheDirectory: path.join(app.getPath("userData"), "sealed-test-cache"), safeStorage,
      panelSession: { protocol: { handle() {} }, fetch: async input => {
        const resource = new URL(input).pathname;
        return new Response(resource === "/umbra-panel.json" ? JSON.stringify(nextManifest) : publicBundle.bytes.get(resource));
      } },
    };
    const current = createPanelBundle(updateOptions);
    assert.equal(await current.update(), true);
    assert.equal(current.revision, publicBundle.manifest.revision, "Active code generation is immutable");
    assert.equal(createPanelBundle(updateOptions).revision, nextManifest.revision, "OS-encrypted cache loads after restart");
  }
  console.log("UMBRA_LOCAL_PANEL_OK " + JSON.stringify({ firstDocumentMs, pendingDocumentMs, totalFixtureMs: Math.round(performance.now() - started), localResources, serverCalls, blockedCalls }));
  window.destroy();
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
