const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("native single-window startup paints local shell then reveals the panel", { timeout: 30000 }, async t => {
  let executable;
  try { executable = require("electron"); await fs.access(executable); }
  catch (error) { if (process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("Electron executable unavailable"); return; } throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-panel-startup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, UMBRA_STARTUP_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, "panel-startup-harness.cjs")], { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Native startup fixture timeout")); }, 20000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /UMBRA_SEAMLESS_STARTUP_OK/);
});
