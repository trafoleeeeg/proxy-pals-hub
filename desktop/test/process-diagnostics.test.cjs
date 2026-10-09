const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { recordProcessEvent, maintainProcessJournal, startProcessJournalMaintenance, observeContents } = require("../runtime/process-diagnostics.cjs");
const { EventEmitter } = require("node:events");

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

test("lifecycle traces correlate technical runs and reject secret fields and arbitrary codes", t => {
  const { directory, file } = fixture(t);
  const runId = "10000000-0000-4000-8000-000000000009";
  recordProcessEvent(directory, "profile-close-request", { runId, source: "shell-close", profileId: "private-id", cookies: "private-cookie", stack: "private-token" });
  recordProcessEvent(directory, "ipc-operation", { operationId: runId, operation: "close-profile", phase: "failed", elapsedMs: 35, errorCode: "ENOSPC", ok: false });
  recordProcessEvent(directory, "profile-lifecycle", { runId: "private", stage: "cookies", phase: "failed", errorCode: "private", source: "private", version: "private" });
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].runId, runId);
  assert.equal(rows[0].source, "shell-close");
  assert.equal(rows[1].bootId, rows[0].bootId);
  assert.ok(rows[1].seq > rows[0].seq);
  assert.ok(rows[1].uptimeMs >= rows[0].uptimeMs);
  assert.equal(rows[1].errorCode, "ENOSPC");
  assert.equal(rows[1].elapsedMs, 35);
  assert.equal(rows[2].runId, undefined);
  assert.equal(rows[2].stage, "cookies");
  assert.doesNotMatch(raw, /private|profileId|stack|token/);
});

test("UTC day rotation keeps recent evidence and removes rows older than 24 hours", t => {
  const { directory, file } = fixture(t);
  const now = Date.parse("2026-10-10T00:01:00Z");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ at: "2026-10-08T23:59:00Z", event: "browser-start" }, { at: "2026-10-09T23:59:00Z", event: "renderer-gone" }].map(JSON.stringify).join("\n") + "\n");
  fs.utimesSync(file, new Date(now - 120000), new Date(now - 120000));
  assert.equal(maintainProcessJournal(directory, { now }), true);
  assert.equal(fs.existsSync(file), false);
  const previous = fs.readFileSync(file + ".old", "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(previous.map(row => row.event), ["renderer-gone"]);
  assert.equal(maintainProcessJournal(directory, { now: now + 24 * 3600000 }), true);
  assert.equal(fs.existsSync(file + ".old"), false);
});

test("idle maintenance expires stale logs even without any new events", t => {
  const { directory, file } = fixture(t);
  recordProcessEvent(directory, "browser-start");
  const future = Date.now() + 2 * 24 * 3600000;
  assert.equal(maintainProcessJournal(directory, { now: future }), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(file + ".old"), false);
  const stop = startProcessJournalMaintenance(directory);
  assert.equal(typeof stop, "function");
  stop(); stop();
});

test("many diagnostic events retain only two bounded segments", t => {
  const { directory, file } = fixture(t);
  for (let i = 0; i < 200; i++) assert.equal(recordProcessEvent(directory, "process-health", { rssMb: 100, heapMb: 20 }, { maxBytes: 1024 }), true);
  for (const segment of [file, file + ".old"]) {
    assert.ok(fs.statSync(segment).size <= 1400);
    for (const row of fs.readFileSync(segment, "utf8").trim().split("\n")) assert.equal(JSON.parse(row).event, "process-health");
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["process-events.jsonl", "process-events.jsonl.old"]);
});

test("contents observer records numeric load failures and teardown without URLs or error messages", t => {
  const { directory, file } = fixture(t);
  const contents = new EventEmitter(); contents.id = 19; contents.debugger = new EventEmitter();
  observeContents(contents, (event, details) => recordProcessEvent(directory, event, details), "profile-tab");
  contents.emit("did-start-loading");
  contents.emit("did-navigate", {}, "https://private.example/token");
  contents.emit("did-fail-load", {}, -105, "private-error", "https://private.example/token", true);
  contents.debugger.emit("detach", {}, "private-reason");
  contents.emit("destroyed");
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => row.phase), ["did-start-loading", "did-navigate", "did-fail-load", "debugger-detached", "destroyed"]);
  assert.equal(rows[2].netError, -105);
  assert.equal(rows[2].mainFrame, true);
  assert.doesNotMatch(raw, /private|https|token/);
  observeContents(new EventEmitter(), () => { throw new Error("write failed"); }, "panel");
});

test("protection commands retain method and timing, never parameters or responses", t => {
  const { directory, file } = fixture(t);
  recordProcessEvent(directory, "protection-command", { phase: "begin", stage: "Runtime.evaluate", targetType: "page", params: { expression: "private-cookie" } });
  recordProcessEvent(directory, "protection-command", { phase: "done", stage: "Runtime.evaluate", elapsedMs: 3, response: "private-token" });
  const raw = fs.readFileSync(file, "utf8");
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].stage, "Runtime.evaluate");
  assert.equal(rows[1].elapsedMs, 3);
  assert.doesNotMatch(raw, /private|params|response|expression/);
});

test("destroyed contents events never re-read the native ID getter", t => {
  const { directory, file } = fixture(t);
  const contents = new EventEmitter();
  let dead = false;
  Object.defineProperty(contents, "id", { get() { if (dead) throw new Error("Object has been destroyed"); return 29; } });
  observeContents(contents, (event, details) => recordProcessEvent(directory, event, details), "profile-tab");
  dead = true;
  assert.doesNotThrow(() => contents.emit("destroyed"));
  const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(row.phase, "destroyed");
  assert.equal(row.contentsId, 29);
  const failing = new EventEmitter();
  observeContents(failing, () => { throw new Error("ENOSPC"); }, "panel");
  assert.doesNotThrow(() => failing.emit("destroyed"));
});
