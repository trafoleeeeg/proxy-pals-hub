const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdateController } = require("../update-controller.cjs");

function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0;
  let installs = 0;
  updater.checkForUpdates = async () => { checks++; return { updateInfo: { version: "0.4.1" } }; };
  updater.quitAndInstall = () => { installs++; };
  const controller = createUpdateController({
    updater, enabled: true, currentVersion: "0.4.0", onState: () => {},
    hasOpenProfiles: () => false, ...options,
  });
  return { updater, controller, checks: () => checks, installs: () => installs };
}
test("overlapping update checks issue one request", async () => {
  const f = fixture();
  await Promise.all([f.controller.check(), f.controller.check(), f.controller.check()]);
  assert.equal(f.checks(), 1);
});
test("periodic checks preserve downloaded update and install is idempotent", async () => {
  const f = fixture();
  assert.equal(f.updater.autoInstallOnAppQuit, true);
  f.updater.emit("update-downloaded", { version: "0.4.1" });
  await f.controller.check();
  assert.equal(f.checks(), 0);
  assert.equal(f.controller.getState().state, "downloaded");
  assert.equal(f.controller.install().ok, true);
  assert.equal(f.controller.install().ok, true);
  await new Promise(setImmediate);
  assert.equal(f.installs(), 1);
});
test("installer cannot interrupt open profiles or run before download", () => {
  const f = fixture({ hasOpenProfiles: () => true });
  assert.equal(f.controller.install().ok, false);
  f.updater.emit("update-downloaded", { version: "0.4.1" });
  assert.equal(f.controller.install().ok, false);
  assert.equal(f.installs(), 0);
});
test("failed checks report the error and can retry", async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error("Connection failed"); };
  assert.equal((await f.controller.check()).ok, false);
  assert.equal(f.controller.getState().error, "Connection failed");
  f.updater.checkForUpdates = async () => ({ updateInfo: { version: "0.4.1" } });
  assert.equal((await f.controller.check()).ok, true);
});
test("development and portable builds cannot invoke updates", async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.controller.check()).ok, false);
  assert.equal(f.checks(), 0);
  f.controller.dispose();
  assert.equal(f.updater.eventNames().length, 0);
});
test("background download rejection is consumed and surfaced", async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => ({
    updateInfo: { version: "0.4.1" },
    downloadPromise: Promise.reject(new Error("Interrupted download")),
  });
  assert.equal((await f.controller.check()).ok, true);
  await new Promise(setImmediate);
  assert.equal(f.controller.getState().error, "Interrupted download");
});

test("installer event errors release the installation guard and permit a new attempt", async () => {
  const f = fixture();
  f.updater.emit("update-downloaded", { version: "0.4.1" });
  f.updater.quitAndInstall = () => f.updater.emit("error", new Error("Installer could not start"));
  assert.equal(f.controller.install().ok, true);
  assert.equal(f.controller.isInstalling(), true);
  await new Promise(setImmediate);
  assert.equal(f.controller.isInstalling(), false);
  assert.equal(f.controller.getState().error, "Installer could not start");
  f.updater.emit("update-downloaded", { version: "0.4.1" });
  assert.equal(f.controller.install().ok, true);
  await new Promise(setImmediate);
});

test("a profile opened before installer dispatch cancels installation", async () => {
  let opened = false;
  const f = fixture({ hasOpenProfiles: () => opened });
  f.updater.emit("update-downloaded", { version: "0.4.1" });
  assert.equal(f.controller.install().ok, true);
  opened = true;
  await new Promise(setImmediate);
  assert.equal(f.installs(), 0);
  assert.equal(f.controller.isInstalling(), false);
});
