const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function fixture() {
  const child = new EventEmitter();
  const sent = [];
  child.pid = 123;
  child.connected = true;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  child.send = (message, callback) => {
    sent.push(message);
    callback?.(message.payload ? child.sendError : undefined);
  };
  const app = new EventEmitter();
  const exits = [];
  app.getPath = () => "synthetic-user-data";
  app.setPath = () => {};
  app.exit = code => exits.push(code);
  const diagnostics = [];
  const module = { exports: {} };
  const directory = path.resolve(__dirname, "../runtime");
  vm.runInNewContext(fs.readFileSync(path.join(directory, "browser-pipe.cjs"), "utf8"), {
    module, process: { env: {}, execPath: "synthetic-executable", argv: ["synthetic-executable"] },
    require(name) {
      if (name === "node:child_process") return { spawn: () => child };
      if (name === "electron") return { app, dialog: { showErrorBox() {} } };
      if (name === "node:fs") return { mkdtempSync: () => "synthetic-temporary-data", rmSync() {} };
      if (name === "./process-diagnostics.cjs") return { recordProcessEvent: (_directory, event, details = {}) => diagnostics.push({ event, ...details }) };
      if (name.startsWith("./")) return require(path.join(directory, name));
      return require(name);
    },
  });
  return { child, sent, app, exits, diagnostics, api: module.exports };
}

test("pipe failures report one fixed reason while preserving private-pipe cleanup", () => {
  const scenarios = [
    ["write-error", ({ child }) => child.stdio[3].emit("error", new Error("private-cookie"))],
    ["read-error", ({ child }) => child.stdio[4].emit("error", new Error("private-cookie"))],
    ["read-end", ({ child }) => child.stdio[4].emit("end")],
    ["ipc-disconnect", ({ child }) => child.emit("disconnect")],
    ["message-forward-failed", ({ child }) => child.stdio[4].emit("data", Buffer.from("private-invalid-json\0"))],
    ["ipc-send-failed", ({ child }) => { child.sendError = new Error("private-cookie"); child.stdio[4].emit("data", Buffer.from('{"private":"secret"}\0')); }],
    ["read-message-too-large", ({ child }) => child.stdio[4].emit("data", Buffer.alloc(16 * 1024 * 1024 + 1, 120))],
    ["write-message-too-large", ({ child }) => child.emit("message", { channel: "umbra:private-browser-protocol", payload: "x".repeat(16 * 1024 * 1024) })],
  ];
  for (const [reason, trigger] of scenarios) {
    const context = fixture();
    const reasons = [];
    context.api.spawnBrowser("synthetic-executable", [], {}, value => reasons.push(value));
    trigger(context);
    context.child.emit("disconnect");
    assert.deepEqual(reasons, [reason]);
    assert.equal(context.child.stdio[3].destroyed, true);
    assert.equal(context.child.stdio[4].destroyed, true);
    assert.equal(context.sent.filter(message => message.closed === true).length, 1);
    assert.doesNotMatch(JSON.stringify(reasons), /private|secret|cookie/);
  }
});

test("a failing pipe diagnostic callback cannot prevent the existing cleanup", () => {
  const { api, child } = fixture();
  api.spawnBrowser("synthetic-executable", [], {}, () => { throw new Error("diagnostic unavailable"); });
  assert.doesNotThrow(() => child.stdio[4].emit("end"));
  assert.equal(child.stdio[3].destroyed, true);
  assert.equal(child.stdio[4].destroyed, true);
});

test("supervisor records fixed stderr categories and raw exit code without changing exit handling", () => {
  const { api, child, diagnostics, exits } = fixture();
  assert.equal(api.superviseBrowser(), true);
  child.stderr.emit("data", Buffer.from("[123:456:1009/160700.123:FATAL:private.cc(42)] secret https://private.example\n"));
  child.stderr.emit("data", Buffer.from("# Fatal process out of memory: private\n"));
  child.stdio[4].emit("end");
  child.emit("exit", 0xC0000005, null);
  assert.deepEqual(diagnostics, [
    { event: "coordinator-start" },
    { event: "coordinator-native-fatal", category: "native-fatal", childPid: 123 },
    { event: "coordinator-native-fatal", category: "v8-oom", childPid: 123 },
    { event: "coordinator-pipe-closed", reason: "read-end" },
    { event: "coordinator-child-exit", childPid: 123, exitCode: 0xC0000005, signal: null },
  ]);
  assert.deepEqual(exits, [0xC0000005]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|secret|https|\.cc/);
});
