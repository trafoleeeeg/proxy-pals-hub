// Read-only screen capability investigation on synthetic loopback origins.
// Print only matches/capabilities, never the real host's dimensions or DPI.
const { app, BrowserWindow, session } = require("electron");
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
const { applyNativeScreenMetrics, applyFingerprint, normalizeFingerprint } = require("../runtime/fingerprint.cjs");
assert.ok(process.env.UMBRA_SCREEN_TEST_DIR);
app.setPath("userData", process.env.UMBRA_SCREEN_TEST_DIR);
app.setPath("sessionData", path.join(process.env.UMBRA_SCREEN_TEST_DIR, "sessions"));
app.enableSandbox();
let server, win;
const finish = code => { win?.destroy(); server?.close(); app.exit(code); };
setTimeout(() => finish(1), 20000).unref();
app.whenReady().then(async () => {
  const width = 1733, height = 977, dpr = 1;
  const metrics = { width: 0, height: 0, deviceScaleFactor: dpr, mobile: false, screenWidth: width, screenHeight: height };
  const css = `body { --profile-screen: no; } @media (device-width: ${width}px) and (device-height: ${height}px) and (resolution: ${dpr}dppx) { body { --profile-screen: yes; } }`;
  server = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><style>${css}</style><body>Fixture</body>`); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const fp = normalizeFingerprint({ os: "windows", userAgent: "Chrome/152.0.0.0", aggressivePrivacyMode: false, screen: { width, height } });
  const ses = session.fromPartition("screen-diagnostic");
  applyNativeScreenMetrics(ses, fp, { required: true });
  win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: !["about:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname) });
  });
  await win.loadURL("about:blank");
  await applyFingerprint(win.webContents, fp);
  let iframeId;
  win.webContents.debugger.on("message", (_event, method, params) => {
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") iframeId = params.sessionId;
  });
  await win.loadURL(`http://127.0.0.1:${port}`);
  await win.webContents.executeJavaScript(`new Promise(resolve => { const f=document.createElement('iframe');f.onload=resolve;f.src='http://localhost:${port}';document.body.appendChild(f); })`);
  const frame = win.webContents.mainFrame.frames.find(frame => frame.processId !== win.webContents.mainFrame.processId);
  assert.ok(frame && iframeId, "must exercise a separately sandboxed cross-origin renderer");
  const probe = `({ js: screen.width===${width} && screen.height===${height} && devicePixelRatio===${dpr}, stylesheet: getComputedStyle(document.body).getPropertyValue('--profile-screen').trim()==='yes' })`;
  const result = { main: await win.webContents.executeJavaScript(probe), oopif: await frame.executeJavaScript(probe) };
  try {
    await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", metrics, iframeId);
    result.childMetrics = "accepted";
  } catch (error) { result.childMetrics = /top.level/.test(error.message) ? "top-level-only" : "rejected"; }
  // Reapply to the top-level target with a real parameter change, so Chromium
  // cannot short-circuit the update as identical to the existing configuration.
  await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { ...metrics, screenOrientation: { type: "landscapePrimary", angle: 0 } });
  result.reapplied = await frame.executeJavaScript(probe);
  win.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width, height }, deviceScaleFactor: dpr, viewSize: { width: 0, height: 0 }, scale: 1 });
  result.electronEmulation = await frame.executeJavaScript(probe);
  console.log("UMBRA_SCREEN_CAPABILITIES " + JSON.stringify(result));
  finish(0);
}).catch(() => { console.error("SCREEN_CAPABILITY_PROBE_FAILED"); finish(1); });
