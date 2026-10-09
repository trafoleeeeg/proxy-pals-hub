const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("Windows native crash yields a local minidump without a remote upload target", { timeout: 45000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows-only crash capture; Linux is disabled by design"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-native-capture-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }));
  const userData = path.join(root, "fixture-user-data");
  const dumps = path.join(root, "umbra-native-crashes");
  await fs.mkdir(path.join(userData, "diagnostics"), { recursive: true });
  await fs.mkdir(dumps);
  await fs.writeFile(path.join(userData, "diagnostics/native-crash-capture.json"), JSON.stringify({
    enabled: true, directory: dumps, expiresAt: Date.now() + 3600000,
  }));
  const env = { ...process.env, UMBRA_CAPTURE_TEST_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.UMBRA_CAPTURE_TEST_ENGINE || require("electron"), [path.join(__dirname, "native-crash-capture-harness.cjs")], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-4096); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-4096); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Synthetic capture timed out")); }, 20000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.match(result.output, /CAPTURE_LOCAL_ONLY/);
  assert.notEqual(result.code, 0);
  assert.notEqual(result.code, 81, "Synthetic capture failed to initialize");
  const findDumps = async directory => {
    const result = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await findDumps(file));
      else if (entry.isFile() && entry.name.endsWith(".dmp")) result.push(file);
    }
    return result;
  };
  let reports = [];
  for (let i = 0; i < 60 && !reports.length; i++) {
    reports = await findDumps(dumps);
    if (!reports.length) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(reports.length > 0, "Native fault must leave an actual local minidump");
  const summary = require("../scripts/summarize-minidump.cjs").summarizeMinidump(reports[0]);
  assert.match(summary.exceptionCode, /^0x[0-9a-f]{8}$/);
  assert.ok(summary.module, "Captured exception must identify its native module");
  const fd = await fs.open(reports[0]);
  try {
    const header = Buffer.alloc(4);
    await fd.read(header, 0, 4, 0);
    assert.equal(header.toString("ascii"), "MDMP");
  } finally { await fd.close(); }
  const log = await fs.readFile(path.join(userData, "diagnostics/process-events.jsonl"), "utf8");
  assert.match(log, /"state":"enabled"/);
  assert.doesNotMatch(log, /directory|fixture-user-data|submitURL/);
});
