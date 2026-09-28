// Run explicitly against a freshly built engine. Stock Electron must fail.
// No page injections, CDP emulation, real profiles or external sites are used.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

assert.ok(process.env.UMBRA_NATIVE_SCREEN_TEST_DIR, "isolated test directory required");
app.setPath("userData", process.env.UMBRA_NATIVE_SCREEN_TEST_DIR);
app.setPath("sessionData", path.join(process.env.UMBRA_NATIVE_SCREEN_TEST_DIR, "sessions"));
app.enableSandbox();
app.commandLine.appendSwitch("disable-background-networking");
const windows = [];
let server;
const finish = code => {
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  server?.close();
  app.exit(code);
};
setTimeout(() => finish(1), 60000).unref();
const presets = {
  a: { width: 1733, height: 977, availableWidth: 1733, availableHeight: 937, colorDepth: 24, deviceScaleFactor: 1 },
  b: { width: 1371, height: 811, availableWidth: 1371, availableHeight: 771, colorDepth: 24, deviceScaleFactor: 2 },
};

function fixture(route, port) {
  const [key, level = "root"] = route.split("/").filter(Boolean);
  const p = presets[key];
  if (!p) return "<!doctype html>";
  const query = dpr => `(device-width: ${p.width}px) and (device-height: ${p.height}px) and (resolution: ${dpr}dppx)`;
  const child = level === "root" ? `<iframe src="http://localhost:${port}/${key}/child"></iframe>`
    : level === "child" ? `<iframe src="http://127.0.0.1:${port}/${key}/nested"></iframe>` : "";
  return `<!doctype html><html><head><style>
    :root { --screen-match: no; --zoom-match: no; }
    @media ${query(p.deviceScaleFactor)} { :root { --screen-match: yes; } }
    @media ${query(p.deviceScaleFactor * 1.25)} { :root { --zoom-match: yes; } }
    </style><script>
    globalThis.firstScreenCheck = {
      dimensions: screen.width === ${p.width} && screen.height === ${p.height},
      available: screen.availWidth === ${p.availableWidth} && screen.availHeight === ${p.availableHeight} && screen.availLeft === 0 && screen.availTop === 0,
      depth: screen.colorDepth === ${p.colorDepth} && screen.pixelDepth === ${p.colorDepth},
      dpr: devicePixelRatio === ${p.deviceScaleFactor},
      css: getComputedStyle(document.documentElement).getPropertyValue('--screen-match').trim() === 'yes',
      nativeGetter: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Screen.prototype, 'width').get).includes('[native code]')
    };
    </script></head><body>${child}</body></html>`;
}

async function checkFrames(win) {
  const root = win.webContents.mainFrame;
  const child = root.frames[0];
  assert.ok(child, "cross-origin child missing");
  assert.notEqual(child.processId, root.processId, "test must exercise OOPIF with site isolation enabled");
  assert.ok(child.frames[0], "nested child missing");
  for (const frame of [root, child, child.frames[0]]) {
    const checks = await frame.executeJavaScript("globalThis.firstScreenCheck");
    assert.deepEqual(checks, { dimensions: true, available: true, depth: true, dpr: true, css: true, nativeGetter: true });
  }
}

async function checkZoom(win, p) {
  win.webContents.setZoomFactor(1.25);
  let matched = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const root = win.webContents.mainFrame;
    const frames = [root, root.frames[0], root.frames[0].frames[0]];
    matched = (await Promise.all(frames.map(frame => frame.executeJavaScript(`
      Math.abs(devicePixelRatio - ${p.deviceScaleFactor * 1.25}) < 0.0001 &&
      getComputedStyle(document.documentElement).getPropertyValue('--zoom-match').trim() === 'yes'
    `)))).every(Boolean);
    if (matched) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(matched, "native CSS/JS DPR must stay coherent when page zoom changes");
  win.webContents.setZoomFactor(1);
}

app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fixture(new URL(req.url, "http://localhost").pathname, server.address().port));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  for (const [key, p] of Object.entries(presets)) {
    const ses = session.fromPartition(`persist:screen-${key}`);
    assert.equal(typeof ses.setUmbraScreenMetrics, "function", "unpatched Electron: native screen API missing");
    assert.throws(() => ses.setUmbraScreenMetrics({ ...p, width: -1 }));
    assert.throws(() => ses.setUmbraScreenMetrics({ ...p, deviceScaleFactor: "1" }));
    assert.throws(() => ses.setUmbraScreenMetrics({ ...p, availableWidth: p.width + 1 }));
    ses.setUmbraScreenMetrics(p);
    ses.webRequest.onBeforeRequest((details, done) => {
      const url = new URL(details.url);
      done({ cancel: url.protocol !== "about:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === String(port)) });
    });
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.push(win);
    await win.loadURL(`http://127.0.0.1:${port}/${key}`);
    await checkFrames(win);
    assert.throws(() => ses.setUmbraScreenMetrics({ ...p, width: p.width + 1 }), "policy must be immutable once used");
    ses.setUmbraScreenMetrics(p); // Identical initialization is safe/idempotent.
    await checkZoom(win, p);
    win.setSize(901, 683);
    await win.loadURL(`http://localhost:${port}/${key}`);
    // Navigate back across sites and force fresh OOPIF creation.
    await win.loadURL(`http://127.0.0.1:${port}/${key}`);
    await checkFrames(win);
  }
  // Recheck A after B was created: a process-global override would fail here.
  await checkFrames(windows[0]);
  process.stdout.write("UMBRA_NATIVE_SCREEN_OK\n", () => finish(0));
}).catch(error => {
  process.stderr.write("UMBRA_NATIVE_SCREEN_FAILED: " + error.message + "\n", () => finish(1));
});
