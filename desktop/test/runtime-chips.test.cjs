const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnBrowser } = require("../runtime/browser-pipe.cjs");

test("native CHIPS partitions survive encrypted restart without crossing profile boundaries", { timeout: 65000 }, async t => {
  let executable;
  try { executable = process.env.UMBRA_TEST_ELECTRON_BINARY || require("electron"); await fs.access(executable); }
  catch (error) { if (process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("Electron executable unavailable"); return; } throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-chips-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const phase of ["initial", "restart"]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawnBrowser(executable, [path.join(__dirname, "runtime-chips-harness.cjs")], {
        env: { ...process.env, UMBRA_CHIPS_TEST_DIR: directory, UMBRA_CHIPS_TEST_PHASE: phase },
      });
      let output = "";
      child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
      child.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("CHIPS native fixture timed out")); }, 30000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /UMBRA_CHIPS_NATIVE_OK/);
  }
});
