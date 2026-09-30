const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { recordProcessEvent } = require("../runtime/process-diagnostics.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-process-diagnostics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "diagnostics", "process-events.jsonl") };
}

test("process diagnostics retain crash reason and code without site or session data", (t) => {
  const { directory, file } = fixture(t);
  assert.equal(recordProcessEvent(directory, "renderer-gone", {
    role: "profile-tab", reason: "oom", exitCode: -9, childPid: 123,
    url: "https://private.example/?token=secret", cookie: "secret", profileId: "private-id",
  }), true);
  const raw = fs.readFileSync(file, "utf8");
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.event, "renderer-gone");
  assert.equal(entry.role, "profile-tab");
  assert.equal(entry.reason, "oom");
  assert.equal(entry.exitCode, -9);
  assert.equal(entry.childPid, 123);
  assert.ok(Number.isInteger(entry.freeMemoryMb));
  assert.equal(typeof entry.at, "string");
  assert.doesNotMatch(raw, /private|secret|cookie|profileId|token/);
});

test("arbitrary event names and unrecognized Electron details are not logged", (t) => {
  const { directory, file } = fixture(t);
  assert.equal(recordProcessEvent(directory, "private-url", { reason: "https://secret.example/" }), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(recordProcessEvent(directory, "renderer-gone", {
    reason: "https://secret.example/", processType: "secret", signal: "secret", role: "secret",
    exitCode: "secret", childPid: Infinity, contentsId: 12.5,
  }), true);
  const entry = JSON.parse(fs.readFileSync(file, "utf8").trim());
  for (const key of ["reason", "processType", "signal", "role", "exitCode", "childPid", "contentsId"]) {
    assert.equal(Object.hasOwn(entry, key), false);
  }
});

test("close progress records only approved phases without profile identifiers", (t) => {
  const { directory, file } = fixture(t);
  recordProcessEvent(directory, "profile-close-phase", { phase: "cookies", profileId: "private-id", url: "https://private.example" });
  recordProcessEvent(directory, "profile-close-phase", { phase: "https://private.example" });
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].phase, "cookies");
  assert.equal(Object.hasOwn(rows[1], "phase"), false);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /private|profileId|https/);
});

test("process diagnostics rotate bounded local logs and do not throw on failed writes", (t) => {
  const { directory, file } = fixture(t);
  for (let i = 0; i < 8; i++) assert.equal(recordProcessEvent(directory, "browser-start", {}, { maxBytes: 120 }), true);
  assert.equal(fs.existsSync(file + ".old"), true);
  assert.ok(fs.statSync(file).size < 320);
  assert.equal(recordProcessEvent("\0", "browser-start"), false);
});
