const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { testCertificate } = require("./runtime-proxy-fixtures.cjs");

async function runNativeHarness(t, storageMode = "native") {
  if (process.env.UMBRA_NATIVE_DIAGNOSTIC === "1") {
    assert.notEqual(process.env.UMBRA_REQUIRE_NATIVE, "1", "Diagnostic mode cannot satisfy a required native test");
    assert.notEqual(process.env.UMBRA_REQUIRE_DPAPI, "1", "Diagnostic mode cannot satisfy a required DPAPI test");
    t.diagnostic("DIAGNOSTIC ONLY: Chromium renderer sandbox disabled inside the test process. No production sandbox or DPAPI validation is claimed.");
  }
  let electron;
  try { electron = require("electron"); await fs.access(electron); }
  catch (error) {
    if (process.platform === "linux" && process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("NATIVE ELECTRON NOT RUN: Linux CI intentionally omits the Electron binary. Run on Windows before release."); return; }
    throw error;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-electron-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const certificate = testCertificate(directory);
  for (const phase of storageMode === "native" ? ["initial", "restart"] : ["initial"]) {
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env, UMBRA_RUNTIME_TEST_DIR: directory, UMBRA_RUNTIME_TEST_PHASE: phase, UMBRA_RUNTIME_TEST_STORAGE: storageMode, NODE_EXTRA_CA_CERTS: certificate.certFile };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [path.join(__dirname, "runtime-electron-harness.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      // This isolated harness uses local fixture credentials only.
      child.stdout.on("data", (chunk) => {
        output = (output + chunk).slice(-65536);
        // Electron may wait for its workers after a failed renderer launch.
        if (/UMBRA_NATIVE_(?:RENDERER_UNAVAILABLE|TEST_FAILED)/.test(output)) child.kill();
      });
      child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-65536); });
      child.on("error", reject);
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron ${phase} harness timed out: ${output}`)); }, 40000);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    if (result.code === 77 && /UMBRA_NATIVE_DPAPI_UNAVAILABLE/.test(result.output) && process.env.UMBRA_REQUIRE_DPAPI !== "1") {
      t.skip("NATIVE DPAPI RESTART NOT RUN: OS cookie encryption is unavailable for this account. Production remains fail closed. Run $env:UMBRA_REQUIRE_DPAPI='1'; npm --prefix desktop test from a normal Windows user session before release.");
      return;
    }
    if (/UMBRA_NATIVE_RENDERER_UNAVAILABLE/.test(result.output) && process.env.UMBRA_REQUIRE_NATIVE !== "1" && process.env.UMBRA_REQUIRE_DPAPI !== "1") {
      t.skip("NATIVE BROWSER NOT RUN: Windows sandbox account rejected the Chromium renderer (launch-failed, exit 49). Run with UMBRA_REQUIRE_NATIVE=1 in a normal user session before release.");
      return;
    }
    assert.equal(result.code, 0, `Electron ${phase} failed: ${result.output}`);
    assert.match(result.output, /UMBRA_NATIVE_TEST_OK/);
  }
}

if (require.main === module) test("real Electron: native OS encrypted cookie restart", { timeout: 90000 }, (t) => runNativeHarness(t));
module.exports = { runNativeHarness };
