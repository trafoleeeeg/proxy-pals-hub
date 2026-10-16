const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

test("native hidden panel close ordering and explicit shutdown consent", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows native menu regression fixture"); return; }
  const executable = process.env.UMBRA_PANEL_CLOSE_ELECTRON || require("electron");
  assert.ok(path.isAbsolute(executable));
  await fs.access(executable);
  for (const scenario of ["legacy-menu-close", "guard-cancel", "guard-confirm"]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-panel-close-test-"));
    try {
      const env = { ...process.env, UMBRA_PANEL_CLOSE_TEST_DIR: directory, UMBRA_PANEL_CLOSE_SCENARIO: scenario };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(executable, [path.join(__dirname, "panel-close-native-harness.cjs")], {
          env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
        // Only fixture diagnostics enter test output, never host/GPU paths.
        child.stderr.on("data", () => {});
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${scenario} timed out`)); }, 18000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
      });
      assert.equal(result.code, 0, result.output);
      assert.ok(result.output.includes(`UMBRA_PANEL_CLOSE_OK ${scenario}`), result.output);
      t.diagnostic(result.output.trim());
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});
