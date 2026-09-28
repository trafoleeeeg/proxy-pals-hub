const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnBrowser } = require("../runtime/browser-pipe.cjs");

test("background workers retain profile identity before execution across close and app restart", { timeout: 110000 }, async t => {
  let electron;
  try { electron = require("electron"); await fs.access(electron); }
  catch (error) { if (process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("Electron executable unavailable"); return; } throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-worker-lifecycle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const phase of ["initial", "restart"]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawnBrowser(electron, [path.join(__dirname, "runtime-worker-lifecycle-harness.cjs")], {
        env: { ...process.env, UMBRA_WORKER_TEST_DIR: directory, UMBRA_WORKER_TEST_PHASE: phase },
      });
      let output = "";
      child.stdout.on("data", b => { output = (output + b).slice(-8192); });
      child.stderr.on("data", b => { output = (output + b).slice(-8192); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Worker lifecycle timeout")); }, 50000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /UMBRA_WORKER_LIFECYCLE_OK/);
  }
});
