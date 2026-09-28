const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnBrowser } = require("../runtime/browser-pipe.cjs");

test("release gate: real CSS in an OOPIF must use profile screen metrics", { timeout: 30000 }, async t => {
  let executable;
  try { executable = require("electron"); }
  catch { if (process.env.UMBRA_REQUIRE_NATIVE === "1") throw new Error("Electron required"); t.skip("Electron unavailable"); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-screen-diagnostic-"));
  try {
    const child = spawnBrowser(executable, [path.join(__dirname, "runtime-screen-diagnostic-harness.cjs")], { env: { ...process.env, UMBRA_SCREEN_TEST_DIR: directory } });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("screen diagnostic timeout")); }, 25000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 0, output);
    const match = /UMBRA_SCREEN_CAPABILITIES (.+)/.exec(output);
    assert.ok(match, "missing diagnostic");
    const result = JSON.parse(match[1]);
    console.log("UMBRA_SCREEN_CAPABILITIES " + JSON.stringify(result));
    assert.deepEqual(result.main, { js: true, stylesheet: true });
    // Deliberately red until the native engine gap is actually closed. Do not
    // replace this assertion with a JS-only test or disable site isolation.
    assert.deepEqual(result.oopif, { js: true, stylesheet: true }, "Release blocked: cross-origin CSS still uses host screen data");
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
