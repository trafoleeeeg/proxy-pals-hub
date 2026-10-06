const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

test("native HTTPS-origin local panel hydrates offline without privileged data", { timeout: 30000 }, async t => {
  let executable;
  try { executable = require("electron"); await fs.access(executable); await fs.access(path.join(__dirname, "../.panel/umbra-panel.json")); }
  catch (error) { if (process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("Built panel/Electron unavailable"); return; } throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-local-panel-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, UMBRA_STARTUP_TEST_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, "panel-bundle-harness.cjs")], { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", bytes => { output = (output + bytes).slice(-12000); });
    child.stderr.on("data", bytes => { output = (output + bytes).slice(-12000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Local panel fixture timeout: " + output)); }, 20000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /UMBRA_LOCAL_PANEL_OK/);
});
