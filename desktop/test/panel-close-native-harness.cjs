const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, Menu } = require("electron");

// This fixture never loads the real panel, a website, account or profile data.
const directory = process.env.UMBRA_PANEL_CLOSE_TEST_DIR;
assert.ok(directory && path.isAbsolute(directory), "An isolated fixture directory is required");
app.setPath("userData", directory);
app.setPath("sessionData", directory);
app.setName("Umbra synthetic panel shutdown fixture");
app.enableSandbox();
app.disableHardwareAcceleration();

const scenario = process.env.UMBRA_PANEL_CLOSE_SCENARIO;
const events = [];
const record = (event) => events.push(event);
const fail = (error) => {
  process.stdout.write(`UMBRA_PANEL_CLOSE_FAILED ${scenario}: ${error.message}\n`, () => app.exit(1));
};
setTimeout(() => fail(new Error("Native shutdown fixture timed out")), 12000).unref();
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const panel = new BrowserWindow({ show: false, autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  assert.equal(panel.isVisible(), false);
  const flatten = (menu) => (menu?.items || []).flatMap((item) => [item, ...flatten(item.submenu)]);
  const closeItem = flatten(Menu.getApplicationMenu()).find((item) => item.role === "close");
  assert.ok(closeItem, "Electron's default Window menu has a native Close action");
  assert.equal(closeItem.accelerator, "CommandOrControl+W");
  assert.equal(panel.isMenuBarVisible(), false, "autoHideMenuBar hides but does not remove the menu");

  if (scenario === "legacy-menu-close") {
    let quitting = false;
    let closing = false;
    // Match main.cjs 0.4.59's listener registration order exactly. The role
    // handler is the native menu action behind Ctrl+W, not a keyboard simulation.
    panel.on("close", (event) => {
      if (!quitting) { event.preventDefault(); app.quit(); }
    });
    panel.on("close", () => record("panel-close"));
    app.on("before-quit", (event) => {
      if (quitting) return;
      if (!closing) record("browser-before-quit");
      event.preventDefault();
      if (closing) return;
      closing = true;
      Promise.resolve().then(() => record("profile-close-request:app-quit")).then(() => {
        quitting = true;
        app.quit();
      }).catch(fail);
    });
    app.on("will-quit", () => {
      try {
        record("will-quit");
        assert.deepEqual(events.slice(0, 3), ["browser-before-quit", "panel-close", "profile-close-request:app-quit"]);
        process.stdout.write(`UMBRA_PANEL_CLOSE_OK ${scenario} ${events.join(" > ")}\n`);
      } catch (error) { fail(error); }
    });
    closeItem.click({}, panel, panel.webContents);
    return;
  }

  const { createAppShutdown } = require("../runtime/app-shutdown.cjs");
  let openProfiles = true;
  let prompts = 0;
  let flushes = 0;
  let completed = 0;
  const shutdown = createAppShutdown({
    app,
    hasOpenProfiles: () => openProfiles,
    closeProfiles: async () => {
      flushes++;
      record("flush-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      openProfiles = false;
      record("flush-done");
    },
    confirmQuit: async () => { prompts++; record("confirm"); return scenario === "guard-confirm"; },
    diagnose: (event) => record(event),
    onComplete: () => { completed++; record("complete"); },
    onError: fail,
  });
  app.on("before-quit", shutdown.beforeQuit);
  panel.on("close", (event) => {
    if (!shutdown.isQuitting()) { event.preventDefault(); shutdown.requestQuit("panel-close"); }
  });
  panel.removeMenu();
  assert.equal(panel.isMenuBarVisible(), false);

  if (scenario === "guard-cancel") {
    // An unknown quit and repeated close intent race while the prompt is open.
    app.quit();
    panel.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(prompts, 1, "Only one confirmation may be pending");
    assert.equal(flushes, 0, "Cancel must not close or save a running profile");
    assert.equal(completed, 0);
    assert.equal(openProfiles, true);
    assert.equal(panel.isDestroyed(), false);
    assert.equal(shutdown.isClosing(), false);
    assert.equal(shutdown.isQuitting(), false);
    process.stdout.write(`UMBRA_PANEL_CLOSE_OK ${scenario}\n`, () => app.exit(0));
    return;
  }
  assert.equal(scenario, "guard-confirm");
  app.on("will-quit", () => {
    try {
      record("will-quit");
      assert.equal(prompts, 1);
      assert.equal(flushes, 1);
      assert.equal(completed, 1);
      assert.equal(openProfiles, false);
      assert.ok(events.indexOf("flush-done") < events.indexOf("will-quit"));
      process.stdout.write(`UMBRA_PANEL_CLOSE_OK ${scenario}\n`);
    } catch (error) { fail(error); }
  });
  panel.close();
}).catch(fail);
