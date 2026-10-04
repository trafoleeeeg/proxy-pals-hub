const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const pkg = require("../package.json");
const lock = require("../package-lock.json");

test("Electron download tools exclude the vulnerable legacy HTTP cache chain", () => {
  assert.equal(pkg.overrides["@electron/get"], "5.1.0");
  assert.equal(lock.packages["node_modules/@electron/get"].version, "5.1.0");
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert.equal(/(?:^|\/)node_modules\/(?:got|cacheable-request|http-cache-semantics)$/.test(name), false, name);
    if (name.endsWith("node_modules/@electron/get")) assert.equal(entry.version, "5.1.0", name);
  }
});

test("electron-builder can load the pinned downloader from its CommonJS caller", (t) => {
  let builder;
  try { builder = require.resolve("app-builder-lib"); }
  catch { t.skip("Desktop build dependencies are installed in CI"); return; }
  const fromBuilder = createRequire(builder);
  const downloader = fromBuilder("@electron/get");
  assert.equal(typeof downloader.downloadArtifact, "function");
  assert.equal(typeof downloader.download, "function");
  assert.equal(typeof downloader.initializeProxy, "function");
});
