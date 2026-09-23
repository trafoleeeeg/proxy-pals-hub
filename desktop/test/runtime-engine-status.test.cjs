const test = require("node:test");
const assert = require("node:assert/strict");
const { checkEngineVersions, compareVersions } = require("../runtime/engine-status.cjs");

test("engine check distinguishes a newer Chrome from an installable Electron update", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(url.includes("npmjs") ? { version: "44.4.5" } : { channels: { Stable: { version: "154.0.8037.57" } } }));
  };
  const result = await checkEngineVersions({ fetcher, installedElectron: "44.4.5", installedChromium: "152.0.7977.130" });
  assert.equal(result.electronUpdateAvailable, false);
  assert.equal(result.chromeMajorAhead, true);
  assert.equal(result.stableChrome, "154.0.8037.57");
  assert.equal(calls.length, 2);
  assert.equal(compareVersions("44.4.10", "44.4.5"), 1);
});

test("engine check reports newer Electron and rejects invalid or failed sources", async () => {
  const fetcher = async (url) => new Response(JSON.stringify(url.includes("npmjs") ? { version: "45.0.0" } : { channels: { Stable: { version: "154.0.8037.57" } } }));
  const result = await checkEngineVersions({ fetcher, installedElectron: "44.4.5", installedChromium: "152.0.7977.130" });
  assert.equal(result.electronUpdateAvailable, true);
  await assert.rejects(checkEngineVersions({ fetcher: async () => new Response("bad", { status: 503 }), installedElectron: "44.4.5", installedChromium: "152.0.7977.130" }));
  await assert.rejects(checkEngineVersions({ fetcher: async () => new Response(JSON.stringify({ version: "45.0.0-beta.1" })), installedElectron: "44.4.5", installedChromium: "152.0.7977.130" }));
});
