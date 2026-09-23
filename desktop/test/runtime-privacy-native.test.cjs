const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

test("sandboxed Electron privacy defaults and exact-origin compatibility", { timeout: 65000 }, async (t) => {
  let electron;
  try { electron = require("electron"); await fs.access(electron); }
  catch (error) { if (process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("Electron executable unavailable"); return; } throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-privacy-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, UMBRA_PRIVACY_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(__dirname, "runtime-privacy-harness.cjs")], { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Privacy fixture timed out")); }, 50000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /UMBRA_PRIVACY_NATIVE_OK/);
});
