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

test("page protection diagnostics retain only fixed stage/type/reason, never protocol payloads", t => {
  const { directory, file } = fixture(t);
  recordProcessEvent(directory, "page-protection", { reason: "command-failed", stage: "Runtime.evaluate", targetType: "iframe",
    error: "private-cookie", expression: "private-token", url: "https://private.example" });
  recordProcessEvent(directory, "page-protection", { reason: "private", stage: "private", targetType: "private" });
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].reason, "command-failed");
  assert.equal(rows[0].stage, "Runtime.evaluate");
  assert.equal(rows[0].targetType, "iframe");
  for (const key of ["reason", "stage", "targetType"]) assert.equal(rows[1][key], undefined);
  assert.doesNotMatch(raw, /private|cookie|token|expression|https/);
});

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

test("Windows unsigned native exit codes and signed exit codes retain their original number", (t) => {
  const { directory, file } = fixture(t);
  const codes = [-2147483648, -1073741819, -1, 0, 1, 2147483647, 2147483648, 0xC0000005, 0xC0000409, 0xFFFFFFFF];
  for (const exitCode of codes) recordProcessEvent(directory, "coordinator-child-exit", { exitCode, childPid: 123 });
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => row.exitCode), codes);
});

test("exit code validation rejects out-of-range values without widening process IDs", (t) => {
  const { directory, file } = fixture(t);
  for (const value of [-2147483649, 4294967296, 1.5, Infinity, -Infinity, NaN, "3221225477", null]) {
    recordProcessEvent(directory, "coordinator-child-exit", { exitCode: value });
  }
  for (const value of [-1, 0, 1.5, 2147483648, 0xFFFFFFFF, Infinity, "123", null]) {
    recordProcessEvent(directory, "coordinator-child-exit", { childPid: value, contentsId: value });
  }
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  for (const row of rows) {
    for (const key of ["exitCode", "childPid", "contentsId"]) assert.equal(Object.hasOwn(row, key), false);
  }
});

test("coordinator diagnostics persist only fixed fatal categories and pipe reasons", (t) => {
  const { directory, file } = fixture(t);
  recordProcessEvent(directory, "coordinator-native-fatal", {
    category: "native-fatal", childPid: 123, source: "private.cc", line: 123, message: "private-cookie", url: "https://private.example",
  });
  recordProcessEvent(directory, "coordinator-native-fatal", { category: "v8-oom" });
  recordProcessEvent(directory, "coordinator-native-fatal", { category: "private", reason: "private" });
  recordProcessEvent(directory, "coordinator-pipe-closed", { reason: "message-forward-failed", payload: "private-cookie" });
  recordProcessEvent(directory, "coordinator-pipe-closed", { reason: "private" });
  assert.equal(recordProcessEvent(directory, "panel-bundle-fallback", { error: "private-cookie" }), true);
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].category, "native-fatal");
  assert.equal(rows[1].category, "v8-oom");
  assert.equal(rows[2].category, undefined);
  assert.equal(rows[2].reason, undefined);
  assert.equal(rows[3].reason, "message-forward-failed");
  assert.equal(rows[4].reason, undefined);
  assert.equal(rows[5].event, "panel-bundle-fallback");
  assert.doesNotMatch(raw, /private|cookie|"source"|"message"|"payload"|https/);
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

test("cleanup diagnostics identify the failed step without recording error payloads", t => {
  const { directory, file } = fixture(t);
  recordProcessEvent(directory, "profile-cleanup-failed", { operation: "workers", elapsedMs: 15001, error: "private-cookie", profileId: "private-id" });
  recordProcessEvent(directory, "profile-cleanup-failed", { operation: "private", elapsedMs: -1 });
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].operation, "workers");
  assert.equal(rows[0].elapsedMs, 15001);
  assert.equal(rows[1].operation, undefined);
  assert.equal(rows[1].elapsedMs, undefined);
  assert.doesNotMatch(raw, /private|profileId|cookie/);
});

test("worker diagnostics retain only approved stages, reasons and outcomes", (t) => {
  const { directory, file } = fixture(t);
  recordProcessEvent(directory, "background-worker", {
    reason: "close-failed", stage: "Runtime.enable", workerType: "service_worker", outcome: "stopped",
    url: "https://private.example", error: "secret", targetId: "private-target", fingerprint: "private-device",
  });
  recordProcessEvent(directory, "background-worker", {
    reason: "private", stage: "private", workerType: "private", outcome: "private",
  });
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].reason, "close-failed");
  assert.equal(rows[0].stage, "Runtime.enable");
  assert.equal(rows[0].workerType, "service_worker");
  assert.equal(rows[0].outcome, "stopped");
  for (const key of ["reason", "stage", "workerType", "outcome"]) assert.equal(Object.hasOwn(rows[1], key), false);
  assert.doesNotMatch(raw, /private|secret|fingerprint|targetId|https/);
});
