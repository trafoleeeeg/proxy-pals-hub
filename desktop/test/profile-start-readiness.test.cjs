const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnBrowser } = require("../runtime/browser-pipe.cjs");
test("production WebContentsView and restored-profile startup initialize blank before CDP", { timeout: 35000 }, async t => {
  let executable;
  try { executable = process.env.UMBRA_TEST_ELECTRON_BINARY || require("electron"); await fs.access(executable); }
  catch (error) { if (process.env.UMBRA_REQUIRE_NATIVE !== "1") { t.skip("Electron unavailable"); return; } throw error; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-start-readiness-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const result = await new Promise((resolve, reject) => {
    const child = spawnBrowser(executable, [path.join(__dirname, "profile-start-readiness-harness.cjs")], { env: { ...process.env, UMBRA_START_TEST_DIR: directory } });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Startup fixture timeout")); }, 32000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /UMBRA_START_READINESS_OK/);
  assert.match(result.output, /SYNTHETIC_NAMED_WORKER_READY classic/);
  assert.match(result.output, /SYNTHETIC_NAMED_WORKER_READY module/);
  assert.match(result.output, /SYNTHETIC_FULL_PROFILE_NAMED_WORKERS_OK/);
  assert.match(result.output, /SYNTHETIC_REUSED_RENDERER_IFRAMES_OK/);
  assert.match(result.output, /SYNTHETIC_FULL_PROFILE_IFRAMES_OK/);
});
