const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const executable = process.argv[2];
  const surface = process.argv[3] || "screen";
  assert.ok(["screen", "hardware"].includes(surface), "Unknown native fixture");
  const marker = `UMBRA_NATIVE_${surface.toUpperCase()}`;
  assert.ok(executable && path.isAbsolute(executable), "Pass an absolute path to the custom Electron executable");
  await fs.access(executable);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `umbra-native-${surface}-`));
  try {
    // Reuse synthetic session directories across two complete browser restarts.
    for (let launch = 0; launch < 2; launch++) {
      const env = { ...process.env, [`${marker}_TEST_DIR`]: directory };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, [path.join(__dirname, `test-${surface}-native.cjs`)], {
        env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output = (output + chunk).slice(-32768); });
      child.stderr.on("data", chunk => {
        // Only print our synthetic fixture diagnostics, not host GPU paths.
        const lines = String(chunk).split(/\r?\n/).filter(line => line.startsWith(`${marker}_FAILED:`));
        for (const line of lines) process.stderr.write(line + "\n");
      });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`Native ${surface} fixture timed out`)); }, 150000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, `Native ${surface} fixture failed`);
      assert.ok(output.includes(`${marker}_OK`), `Missing native ${surface} success marker`);
    }
    console.log(`Native ${surface} isolation passed two browser launches`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
