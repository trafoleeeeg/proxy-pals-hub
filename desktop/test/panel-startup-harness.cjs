const electron = require("electron");
const { app, BrowserWindow, webContents } = electron;
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createPanelStartup, panelBackground } = require("../runtime/panel-startup.cjs");
app.setPath("userData", process.env.UMBRA_STARTUP_TEST_DIR);
app.enableSandbox();

app.whenReady().then(async () => {
  let release;
  const prepared = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><html lang='ru'><title>Fixture panel</title><body style='background:#181818;color:white'>Test panel ready</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const window = new BrowserWindow({ show: false, backgroundColor: panelBackground, webPreferences: {
    partition: "startup-native-fixture", sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  const startup = createPanelStartup(electron, window, {
    appUrl: `http://127.0.0.1:${server.address().port}/app`, version: "fixture", prepare: prepared,
    showError: async () => { throw new Error("Unexpected native navigation failure"); },
  });
  const loading = startup.start();
  assert.equal(window.isVisible(), true, "shell visible before network preparation");
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(requests, 0);
  const overlay = window.contentView.children.at(-1);
  const overlayContents = overlay.webContents;
  if (overlayContents.isLoading()) await once(overlayContents, "did-finish-load");
  assert.equal(overlayContents.getLastWebPreferences().sandbox, true, "skeleton sandbox");
  assert.equal(overlayContents.getLastWebPreferences().javascript, false, "skeleton JS disabled");
  const skeletonImage = await overlayContents.capturePage();
  assert.equal(skeletonImage.isEmpty(), false);
  release(); await loading;
  assert.ok(requests > 0);
  assert.equal(startup.state().ready, false, "navigation completion is not a committed React paint");
  const ready = await window.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(document.body.textContent))))");
  assert.match(ready, /Test panel ready/);
  const overlayClosed = once(overlayContents, "destroyed");
  startup.ready();
  await overlayClosed;
  assert.equal(overlayContents.isDestroyed(), true);
  assert.equal(window.contentView.children.includes(overlay), false);
  assert.equal(window.isVisible(), true);
  assert.equal(window.listenerCount("resize"), 0);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  window.destroy();
  assert.equal(webContents.getAllWebContents().includes(overlayContents), false);
  let finishPreparation;
  const closingWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const earlyClose = createPanelStartup(electron, closingWindow, {
    appUrl: `http://127.0.0.1:${server.address().port}/app`, version: "fixture",
    prepare: new Promise(resolve => { finishPreparation = resolve; }), showError: async () => false,
  });
  const waiting = earlyClose.start();
  const closingOverlay = closingWindow.contentView.children.at(-1).webContents;
  const closePaint = once(closingOverlay, "destroyed");
  closingWindow.destroy();
  finishPreparation();
  await waiting; await closePaint;
  assert.equal(closingOverlay.isDestroyed(), true);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log("UMBRA_SEAMLESS_STARTUP_OK");
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
