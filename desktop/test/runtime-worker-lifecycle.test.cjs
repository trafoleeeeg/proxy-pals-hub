const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnBrowser } = require("../runtime/browser-pipe.cjs");

test("background workers retain identity and durable cookies across close and abrupt app exit", { timeout: 165000 }, async t => {
  let electron;
  try { electron = process.env.UMBRA_TEST_ELECTRON_BINARY || require("electron"); await fs.access(electron); }
  catch (error) { if (process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("Electron executable unavailable"); return; } throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-worker-lifecycle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const phase of ["initial", "crash", "restart"]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawnBrowser(electron, [path.join(__dirname, "runtime-worker-lifecycle-harness.cjs")], {
        env: { ...process.env, UMBRA_WORKER_TEST_DIR: directory, UMBRA_WORKER_TEST_PHASE: phase },
      });
      let output = "";
      let crashTerminated = false;
      child.stdout.on("data", b => {
        output = (output + b).slice(-8192);
        if (phase === "crash" && !crashTerminated && output.includes("UMBRA_CHECKPOINT_BEFORE_ABRUPT_EXIT")) {
          crashTerminated = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", b => { output = (output + b).slice(-8192); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Worker lifecycle timeout")); }, 50000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); resolve({ code, output, crashTerminated }); });
    });
    if (phase === "crash") assert.equal(result.crashTerminated, true, result.output);
    else assert.equal(result.code, 0, result.output);
    assert.match(result.output, phase === "crash" ? /UMBRA_CHECKPOINT_BEFORE_ABRUPT_EXIT/ : /UMBRA_WORKER_LIFECYCLE_OK/);
  }
});
