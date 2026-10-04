const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function fixture() {
  const protocol = new EventEmitter();
  const calls = [];
  let intercept = async () => undefined;
  const guards = new Map();
  protocol.send = async (method, args, id) => {
    calls.push({ method, args, id });
    const result = await intercept(method, args, id);
    return result ?? (method === "Target.closeTarget" ? { success: true } : {});
  };
  class WebContentsView {
    constructor({ webPreferences: { session } }) {
      const debuggerApi = new EventEmitter();
      guards.set(session.contextId, debuggerApi);
      debuggerApi.attach = () => {};
      debuggerApi.sendCommand = async method => {
        if (method === "ServiceWorker.enable") debuggerApi.emit("message", {}, "ServiceWorker.workerVersionUpdated", { versions: [] });
        return method === "Target.getTargetInfo" ? { targetInfo: { browserContextId: session.contextId } } : {};
      };
      this.webContents = {
        setWindowOpenHandler() {}, loadURL: async () => {}, close() {},
        debugger: debuggerApi,
      };
    }
  }
  const module = { exports: {} };
  const directory = path.resolve(__dirname, "../runtime");
  const source = fs.readFileSync(path.join(directory, "background-workers.cjs"), "utf8");
  vm.runInNewContext(source, {
    module, __dirname: directory, setTimeout, clearTimeout,
    require(name) {
      if (name === "electron") return { WebContentsView };
      if (name === "./browser-pipe.cjs") return { connectBrowserProtocol: () => protocol };
      if (name === "./fingerprint.cjs") return {
        userAgentOverride: () => ({}),
        applyLocale: (send, locale, id) => send("Emulation.setLocaleOverride", { locale }, id),
      };
      return require(name);
    },
  });
  const diagnostics = [];
  const failures = [];
  const policies = new Map();
  const fp = { timezone: "UTC", languages: ["en-US"], hardwareConcurrency: 8 };
  return {
    protocol, calls, diagnostics, failures, guards,
    versions(versions, contextId = "a") { guards.get(contextId).emit("message", {}, "ServiceWorker.workerVersionUpdated", { versions }); },
    intercept(fn) { intercept = fn; },
    async protect(contextId = "a") {
      const policy = { blocked: false, connectionsClosed: false };
      policies.set(contextId, policy);
      const session = {
        contextId,
        webRequest: { onBeforeRequest(handler) {
          handler({}, ({ cancel }) => { policy.blocked = cancel; });
        } },
        closeAllConnections: async () => { policy.connectionsClosed = true; },
      };
      const protection = await module.exports.protectBackgroundWorkers(session, fp, {
        onFailure: () => failures.push(contextId),
        onDiagnostic: (details) => diagnostics.push(details),
      });
      return { protection, policy };
    },
    attach({ id = "sw", contextId = "a", type = "service_worker", paused = true, parent } = {}) {
      protocol.emit("message", "Target.attachedToTarget", {
        sessionId: id, waitingForDebugger: paused,
        targetInfo: { targetId: `target-${id}`, browserContextId: contextId, type },
      }, parent);
    },
    destroy(id = "sw") {
      protocol.emit("message", "Target.detachedFromTarget", { sessionId: id });
      protocol.emit("message", "Target.targetDestroyed", { targetId: `target-${id}` });
    },
    async drain() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); },
  };
}

test("worker resumes only after every protection command succeeds", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.attach();
  await f.drain();
  assert.equal(protection.isActive(), true);
  assert.equal(f.calls.at(-1).method, "Runtime.runIfWaitingForDebugger");
  assert.ok(f.calls.findIndex((c) => c.method === "Runtime.evaluate") < f.calls.length - 1);
  assert.equal(f.failures.length, 0);
});

test("shutdown detaches debugger-held workers without waiting for stop acknowledgement", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.attach(); await f.drain();
  let finishStop;
  f.guards.get("a").sendCommand = method => {
    assert.equal(method, "ServiceWorker.stopAllWorkers");
    return new Promise(resolve => { finishStop = resolve; });
  };
  f.intercept(async method => {
    if (method === "Target.closeTarget") return new Promise(() => {});
    if (method === "Target.detachFromTarget") { f.destroy(); finishStop(); }
  });
  await protection.stop();
  assert.equal(protection.isActive(), false);
  assert.deepEqual(f.failures, []);
});

test("shared-worker shutdown requires actual destruction, not closeTarget success", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.attach({ type: "shared_worker" }); await f.drain();
  let completed = false;
  const closing = protection.stop().then(() => { completed = true; });
  await f.drain();
  assert.equal(completed, false);
  f.destroy(); await closing;
  assert.equal(completed, true);
});

test("failed startup closes only a confirmed paused worker, fresh attachment is protected", async () => {
  const f = fixture();
  const { protection, policy } = await f.protect();
  f.intercept(async (method, args, id) => {
    if (method === "Emulation.setTimezoneOverride" && id === "sw") throw new Error("startup race");
    if (method === "Target.closeTarget") {
      f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
      f.destroy();
      return { success: true };
    }
  });
  f.attach();
  await f.drain();
  assert.equal(protection.isActive(), true);
  assert.equal(policy.blocked, false);
  assert.equal(f.calls.some((c) => c.id === "sw" && c.method === "Runtime.runIfWaitingForDebugger"), false);
  assert.equal(f.diagnostics[0].outcome, "worker-closed");
  assert.equal(f.diagnostics[0].stage, "Emulation.setTimezoneOverride");
  f.attach({ id: "replacement" });
  await f.drain();
  assert.equal(f.calls.at(-1).method, "Runtime.runIfWaitingForDebugger");
  assert.equal(f.calls.at(-1).id, "replacement");
  assert.equal(f.failures.length, 0);
});

for (const closeFailure of ["false", "timeout"]) {
  test(`unconfirmed paused-worker closure (${closeFailure}) revokes only its profile`, async () => {
    const f = fixture();
    const a = await f.protect();
    const b = await f.protect("b");
    f.intercept(async (method) => {
      if (method === "Runtime.enable") throw new Error("setup failed");
      if (method === "Target.closeTarget") {
        if (closeFailure === "timeout") throw new Error("timeout");
        return { success: false };
      }
    });
    f.attach();
    await f.drain();
    assert.equal(a.protection.isActive(), false);
    assert.equal(a.policy.blocked, true);
    assert.equal(a.policy.connectionsClosed, true);
    assert.equal(b.protection.isActive(), true);
    assert.equal(b.policy.blocked, false);
    assert.deepEqual(f.failures, ["a"]);
    assert.equal(f.diagnostics[0].reason, "close-failed");
  });
}

test("resume timeout is never treated as proof that a worker remained paused", async () => {
  const f = fixture();
  const { protection, policy } = await f.protect();
  f.intercept(async (method) => { if (method === "Runtime.runIfWaitingForDebugger") throw new Error("timeout"); });
  f.attach();
  await f.drain();
  assert.equal(protection.isActive(), false);
  assert.equal(policy.blocked, true);
  assert.equal(f.diagnostics[0].reason, "resume-failed");
});

test("already executing worker fails closed instead of receiving partial protection", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.attach({ paused: false });
  await f.drain();
  assert.equal(protection.isActive(), false);
  assert.equal(f.calls.some((c) => c.method === "Runtime.evaluate"), false);
  assert.equal(f.diagnostics[0].reason, "started-unprotected");
});

test("worker termination racing setup rejection does not stop the profile", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.intercept(async (method) => {
    if (method === "Runtime.enable") {
      f.protocol.emit("message", "Target.detachedFromTarget", { sessionId: "sw" });
      throw new Error("target gone");
    }
  });
  f.attach();
  await f.drain();
  assert.equal(protection.isActive(), true);
  assert.equal(f.failures.length, 0);
});

test("preload exception cannot resume the unprotected worker", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.intercept(async (method) => {
    if (method === "Target.closeTarget") f.destroy();
    return method === "Runtime.evaluate" ? { exceptionDetails: {} } : undefined;
  });
  f.attach();
  await f.drain();
  assert.equal(protection.isActive(), true);
  assert.equal(f.calls.some((c) => c.method === "Runtime.runIfWaitingForDebugger"), false);
  assert.equal(f.diagnostics[0].outcome, "worker-closed");
});

test("unconfirmed service-worker stop keeps traffic blocked and then fails closed", async () => {
  const f = fixture();
  const a = await f.protect();
  const b = await f.protect("b");
  f.attach();
  await f.drain();
  f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
  await f.drain();
  assert.equal(a.protection.isActive(), false);
  assert.equal(a.policy.connectionsClosed, true);
  assert.equal(f.failures.length, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(a.policy.blocked, true);
  assert.equal(b.protection.isActive(), true);
  assert.equal(f.diagnostics[0].reason, "termination-unconfirmed");
});

test("shared-worker restart reapplies protection before resuming", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.attach({ type: "shared_worker" });
  await f.drain();
  const before = f.calls.length;
  f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
  f.protocol.emit("message", "Inspector.targetReloadedAfterCrash", {}, "sw");
  await f.drain();
  assert.equal(protection.isActive(), true);
  assert.ok(f.calls.slice(before).some((c) => c.method === "Runtime.evaluate"));
  assert.equal(f.calls.at(-1).method, "Runtime.runIfWaitingForDebugger");
  assert.equal(f.failures.length, 0);
});

test("retired service worker must be destroyed, not merely detached, before traffic resumes", async () => {
  const f = fixture();
  const a = await f.protect();
  const b = await f.protect("b");
  f.attach();
  await f.drain();
  f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
  f.protocol.emit("message", "Target.detachedFromTarget", { sessionId: "sw" });
  await f.drain();
  assert.equal(a.protection.isActive(), false);
  assert.equal(b.protection.isActive(), true);
  f.protocol.emit("message", "Target.targetDestroyed", { targetId: "target-sw" });
  await f.drain();
  assert.equal(a.protection.isActive(), true);
  assert.equal(f.failures.length, 0);
  assert.equal(f.diagnostics[0].reason, "worker-retired");
  f.attach({ id: "new-version" });
  await f.drain();
  assert.equal(f.calls.at(-1).id, "new-version");
  assert.equal(f.calls.at(-1).method, "Runtime.runIfWaitingForDebugger");
});

test("confirmed redundant version retires without interrupting replacement connections", async () => {
  const f = fixture();
  const a = await f.protect();
  f.attach();
  await f.drain();
  f.versions([{ versionId: "old", targetId: "target-sw", status: "activated" }]);
  // Chromium can omit targetId once the process has stopped.
  f.versions([{ versionId: "old", status: "redundant" }]);
  f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
  await f.drain();
  assert.equal(a.protection.isActive(), true);
  assert.equal(a.policy.connectionsClosed, false);
  assert.equal(f.failures.length, 0);
  f.destroy();
  await f.drain();
  assert.equal(f.diagnostics[0].reason, "worker-retired");
});

test("in-place service-worker restart remains fail-closed even if destroyed later", async () => {
  const f = fixture();
  const a = await f.protect();
  f.attach();
  await f.drain();
  f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
  f.protocol.emit("message", "Inspector.targetReloadedAfterCrash", {}, "sw");
  f.destroy();
  await f.drain();
  assert.equal(a.protection.isActive(), false);
  assert.equal(a.policy.blocked, true);
  assert.deepEqual(f.failures, ["a"]);
});

test("accepted close without destruction never reopens the network gate", async () => {
  const f = fixture();
  const a = await f.protect();
  f.intercept(async (method) => { if (method === "Runtime.enable") throw new Error("setup failed"); });
  f.attach();
  await f.drain();
  assert.equal(a.protection.isActive(), false);
  assert.equal(f.calls.some(c => c.method === "Runtime.runIfWaitingForDebugger"), false);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(f.failures, ["a"]);
  assert.equal(a.policy.blocked, true);
});

for (const staleReply of ["Target.closeTarget", "Target.detachFromTarget"]) {
  test(`terminal destruction supersedes a late ${staleReply} error`, async () => {
    const f = fixture();
    const a = await f.protect();
    f.intercept(async method => {
      if (method === "Runtime.enable") throw new Error("setup failed");
      if (method === "Target.closeTarget") {
        f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
        f.destroy();
        if (staleReply === method) throw new Error("Target no longer exists");
      }
      if (method === "Target.detachFromTarget" && staleReply === method) {
        f.destroy();
        throw new Error("Session no longer exists");
      }
    });
    f.attach();
    await f.drain();
    assert.equal(a.protection.isActive(), true);
    assert.equal(f.failures.length, 0);
    assert.equal(f.calls.some(c => c.method === "Runtime.runIfWaitingForDebugger"), false);
  });
}

test("a stopped setup continuation cannot resume the replacement shared worker", async () => {
  const f = fixture();
  const a = await f.protect();
  let oldSetup;
  let replacementSetup;
  let evaluations = 0;
  f.intercept(async (method) => {
    if (method === "Runtime.evaluate") {
      evaluations++;
      return new Promise(resolve => { if (evaluations === 1) oldSetup = resolve; else replacementSetup = resolve; });
    }
  });
  f.attach({ type: "shared_worker" });
  await f.drain();
  f.protocol.emit("message", "Inspector.targetCrashed", {}, "sw");
  f.protocol.emit("message", "Inspector.targetReloadedAfterCrash", {}, "sw");
  await f.drain();
  oldSetup({});
  await f.drain();
  assert.equal(f.calls.some(c => c.method === "Runtime.runIfWaitingForDebugger"), false);
  replacementSetup({});
  await f.drain();
  assert.equal(f.calls.filter(c => c.method === "Runtime.runIfWaitingForDebugger").length, 1);
  assert.equal(a.protection.isActive(), true);
});

test("private protocol disconnect revokes all protected profiles", async () => {
  const f = fixture();
  const a = await f.protect();
  const b = await f.protect("b");
  f.protocol.emit("disconnect");
  await f.drain();
  assert.equal(a.protection.isActive(), false);
  assert.equal(b.protection.isActive(), false);
  assert.equal(a.policy.blocked, true);
  assert.equal(b.policy.blocked, true);
  assert.equal(f.diagnostics[0].reason, "protocol-disconnect");
});

test("nested dedicated-worker setup failure uses the parent profile policy", async () => {
  const f = fixture();
  const { protection } = await f.protect();
  f.attach();
  await f.drain();
  f.intercept(async (method, args, id) => {
    if (method === "Runtime.enable" && id === "nested") throw new Error("startup race");
    if (method === "Target.closeTarget") f.destroy("nested");
  });
  f.attach({ id: "nested", contextId: undefined, type: "worker", parent: "sw" });
  await f.drain();
  assert.equal(protection.isActive(), true);
  assert.equal(f.diagnostics[0].workerType, "worker");
  assert.equal(f.diagnostics[0].outcome, "worker-closed");
});

test("diagnostic callback failure does not interfere with fail-closed", async () => {
  const f = fixture();
  // Verify the controller's diagnostic callback is isolated from failures.
  f.diagnostics.push = () => { throw new Error("disk unavailable"); };
  const { protection, policy } = await f.protect();
  f.protocol.emit("disconnect");
  await f.drain();
  assert.equal(protection.isActive(), false);
  assert.equal(policy.blocked, true);
  assert.deepEqual(f.failures, ["a"]);
});

test("late workers in a closed context retain its deny policy without throwing", async () => {
  const f = fixture();
  const a = await f.protect();
  await a.protection.stop();
  for (const id of ["late-detached", "late-destroyed"]) {
    f.attach({ id });
    await f.drain();
    assert.doesNotThrow(() => f.protocol.emit("message", "Inspector.targetCrashed", {}, id));
    if (id === "late-detached") assert.doesNotThrow(() => f.protocol.emit("message", "Target.detachedFromTarget", { sessionId: id }));
    assert.doesNotThrow(() => f.protocol.emit("message", "Target.targetDestroyed", { targetId: `target-${id}` }));
  }
  assert.equal(a.protection.isActive(), false);
  assert.equal(f.calls.some(c => c.method === "Runtime.runIfWaitingForDebugger"), false);
});
