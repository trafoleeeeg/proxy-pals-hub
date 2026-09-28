if (require("../runtime/browser-pipe.cjs").superviseBrowser({ forwardOutput: true })) return;
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { initializeBackgroundWorkers, allowBackgroundWorkers } = require("../runtime/background-workers.cjs");
const directory = process.env.UMBRA_BOOTSTRAP_TEST_DIR;
assert.ok(directory);
app.setPath("userData", path.join(directory, "child"));
app.enableSandbox();
let saved = false;
app.on("before-quit", event => {
  if (saved) return;
  event.preventDefault();
  fs.writeFile(path.join(directory, "flushed.txt"), "synthetic-data-flushed").then(() => { saved = true; app.quit(); });
});
app.whenReady().then(async () => {
  await initializeBackgroundWorkers();
  const ses = session.fromPartition("bootstrap-fixture");
  await allowBackgroundWorkers(ses);
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL("about:blank");
  assert.equal(app.commandLine.hasSwitch("remote-debugging-port"), false);
  assert.equal(app.commandLine.hasSwitch("remote-debugging-pipe"), true);
  console.log("UMBRA_PRIVATE_BOOTSTRAP_OK");
  app.quit();
}).catch(() => { console.error("BOOTSTRAP_FAILED"); app.exit(1); });
