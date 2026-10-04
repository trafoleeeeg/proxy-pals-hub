const fs = require("node:fs");
const path = require("node:path");
const { connectBrowserProtocol } = require("./browser-pipe.cjs");
const documentSource = fs.readFileSync(path.join(__dirname, "..", "fingerprint-preload.cjs"), "utf8");
const sessions = new WeakMap();
const contexts = new Map();
const targets = new Map();
const awaitingContexts = new Map();
// A failed worker shutdown must never be followed by reopening the same
// BrowserContext: an old worker could resume with the new profile network gate.
const unsafeSessions = new WeakSet();
let protocol;
let startup;

function diagnose(state, reason, record, outcome = "stopped") {
  try { state?.onDiagnostic?.({ reason, stage: record?.stage, workerType: record?.info.type, outcome }); }
  catch { /* Diagnostics must not affect protection. */ }
}

function fail(state, reason, record) {
  if (!state?.active || !state.fp) return;
  diagnose(state, reason, record);
  state.active = false;
  state.ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
  void state.ses.closeAllConnections().catch(() => {});
  state.onFailure?.("Защита фоновых процессов недоступна, профиль остановлен");
  void stopState(state).catch(() => {});
}

function findContext(id) {
  if (contexts.has(id)) return Promise.resolve(contexts.get(id));
  // A persisted worker can wake while its Electron session is being opened.
  // Keep it paused until that exact BrowserContext has an explicit policy.
  return new Promise((resolve, reject) => {
    const waiters = awaitingContexts.get(id) || new Set();
    const waiter = { resolve: (state) => { clearTimeout(timer); waiters.delete(waiter); resolve(state); } };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      if (!waiters.size) awaitingContexts.delete(id);
      reject(new Error("Worker session not registered"));
    }, 10000);
    timer.unref?.();
    waiters.add(waiter);
    awaitingContexts.set(id, waiters);
  });
}

async function configureWorker(params, parentSessionId, existing) {
  const { sessionId: id, targetInfo: info, waitingForDebugger } = params;
  // Nested dedicated workers inherit ownership from the attached parent.
  const parent = targets.get(parentSessionId);
  const record = existing || { id, targetId: info.targetId, info, state: parent?.state, cancelled: false, epoch: 0 };
  const epoch = ++record.epoch;
  record.phase = "starting";
  record.stage = "context";
  record.resuming = false;
  record.closing = false;
  targets.set(id, record);
  const send = (method, args, sessionId) => {
    record.stage = method;
    return protocol.send(method, args, sessionId);
  };
  try {
    const state = record.state || await findContext(info.browserContextId);
    record.state = state;
    if (record.cancelled) return;
    if (!state.active) { await protocol.send("Target.closeTarget", { targetId: info.targetId }); return; }
    if (!state.fp) {
      await protocol.send("Runtime.runIfWaitingForDebugger", {}, id);
      await protocol.send("Target.detachFromTarget", { sessionId: id });
      return;
    }
    // An already executing worker may have cached host data. Never silently
    // declare such an attachment protected. Stop it without deleting storage.
    if (!waitingForDebugger) throw new Error("Worker started before protection");
    const fp = state.fp;
    const { userAgentOverride, applyLocale } = require("./fingerprint.cjs");
    if (info.type !== "worker") await send("Inspector.enable", {}, id);
    await send("Runtime.enable", {}, id);
    await send("Emulation.setUserAgentOverride", userAgentOverride(fp), id);
    await send("Emulation.setTimezoneOverride", { timezoneId: fp.timezone }, id);
    await applyLocale(send, fp.languages[0], id);
    if (!fp.nativeHardwareMetrics) await send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: fp.hardwareConcurrency }, id);
    const result = await send("Runtime.evaluate", { expression: `(${documentSource})(${JSON.stringify(fp)});`, returnByValue: true, disableBreaks: true }, id);
    if (result.exceptionDetails) throw new Error("Worker privacy setup failed");
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "worker" }, { exclude: true }],
    }, id);
    if (!state.active || state.fp !== fp || record.cancelled) return;
    // A resume timeout is ambiguous: Chromium may already have executed code.
    record.resuming = true;
    await send("Runtime.runIfWaitingForDebugger", {}, id);
    record.phase = "running";
  } catch {
    if (record.cancelled || record.phase === "stopped" || record.epoch !== epoch) return;
    // A target held behind `waitForDebugger` has not executed site code yet.
    // CDP setup can transiently fail while Chromium is creating a worker (for
    // example during a service-worker update). Closing only that paused target
    // is safe only when Chromium confirms closure and resume was never sent.
    // A subsequent worker attachment must pass the full protection path again.
    if (waitingForDebugger && !record.resuming) {
      record.closing = true;
      try {
        const closed = await protocol.send("Target.closeTarget", { targetId: info.targetId });
        if (closed.success !== true) throw new Error("Worker closure not confirmed");
        record.cancelled = true;
        record.phase = "stopped";
        targets.delete(id);
        diagnose(record.state, "setup-failed", record, "worker-closed");
        return;
      } catch {
        fail(record.state, "close-failed", record);
        return;
      }
    }
    fail(record.state, record.resuming ? "resume-failed" : "started-unprotected", record);
    await protocol.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
  }
}

function initializeBackgroundWorkers() {
  return startup ||= (async () => {
    protocol = connectBrowserProtocol();
    protocol.on("message", (method, params, parentSessionId) => {
      if (method === "Target.attachedToTarget") void configureWorker(params, parentSessionId);
      if (method === "Inspector.targetCrashed") {
        const record = targets.get(parentSessionId);
        if (record) {
          record.phase = "stopped";
          // Chromium does not consistently pause a previously installed SW
          // on an unexpected in-place restart. Revoke the profile immediately;
          // an explicit reopen obtains a fresh, startup-paused target.
          if (record.info.type === "service_worker" && !record.cancelled && !record.closing) fail(record.state, "worker-crashed", record);
        }
      }
      if (method === "Inspector.targetReloadedAfterCrash") {
        const record = targets.get(parentSessionId);
        if (record?.phase === "stopped" && record.info.type === "shared_worker" && !record.cancelled && record.state?.active) {
          void configureWorker({ sessionId: record.id, targetInfo: record.info, waitingForDebugger: true }, null, record);
        }
      }
      if (method === "Target.detachedFromTarget") {
        const record = targets.get(params.sessionId);
        if (record) record.cancelled = true;
        targets.delete(params.sessionId);
      }
    });
    protocol.on("disconnect", () => { for (const state of contexts.values()) fail(state, "protocol-disconnect"); });
    await protocol.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "shared_worker" }, { type: "service_worker" }, { exclude: true }],
    });
  })();
}

async function sessionState(ses) {
  if (unsafeSessions.has(ses)) throw new Error("Background worker shutdown failed; restart Umbra");
  await initializeBackgroundWorkers();
  if (sessions.has(ses)) {
    const state = sessions.get(ses);
    await state.ready;
    return state;
  }
  const { WebContentsView } = require("electron");
  const guard = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  const wc = guard.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  const state = { ses, guard, wc, active: false, fp: null, onFailure: null };
  sessions.set(ses, state);
  state.ready = (async () => { try {
    await wc.loadURL("about:blank");
    wc.debugger.attach("1.3");
    const { targetInfo } = await wc.debugger.sendCommand("Target.getTargetInfo");
    if (!targetInfo.browserContextId) throw new Error("Missing browser context identity");
    state.contextId = targetInfo.browserContextId;
    contexts.set(state.contextId, state);
  } catch (error) {
    sessions.delete(ses);
    wc.close();
    throw error;
  } })();
  await state.ready;
  return state;
}

function publish(state) {
  const waiters = awaitingContexts.get(state.contextId);
  awaitingContexts.delete(state.contextId);
  for (const waiter of waiters || []) waiter.resolve(state);
}

async function allowBackgroundWorkers(ses) {
  const state = await sessionState(ses);
  if (state.fp) throw new Error("Cannot remove profile worker protection");
  state.active = true;
  publish(state);
}

async function stopState(state) {
  state.active = false;
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    const owned = [...targets.values()].filter((record) => record.state === state);
    for (const record of owned) record.cancelled = true;
    // Stops executions, not registrations or cookies/IndexedDB/cache data.
    await state.wc.debugger.sendCommand("ServiceWorker.enable");
    await state.wc.debugger.sendCommand("ServiceWorker.stopAllWorkers");
    await Promise.all(owned.map(async (record) => {
      await protocol.send("Target.closeTarget", { targetId: record.targetId }).catch(() => {});
      await protocol.send("Target.detachFromTarget", { sessionId: record.id }).catch(() => {});
    }));
    state.wc.close();
    state.guard = null;
    sessions.delete(state.ses);
    // Keep only a deny-policy tombstone, not the closed profile or its settings.
    if (contexts.get(state.contextId) === state) contexts.set(state.contextId, { active: false });
  })();
  try { await state.stopping; }
  catch (error) { state.stopping = null; throw error; }
}

async function protectBackgroundWorkers(ses, fp, { onFailure, onDiagnostic } = {}) {
  const state = await sessionState(ses);
  if (state.active) throw new Error("Background profile already active");
  state.fp = fp;
  state.onFailure = onFailure;
  state.onDiagnostic = onDiagnostic;
  state.active = true;
  publish(state);
  return { stop: () => stopState(state), isActive: () => state.active };
}

function backgroundWorkersProtected(ses) { const state = ses && sessions.get(ses); return !!(state?.active && state.fp); }

function quarantineBackgroundWorkers(ses) {
  if (!ses) return;
  unsafeSessions.add(ses);
  const state = sessions.get(ses);
  if (state) {
    state.active = false;
    if (contexts.get(state.contextId) === state) contexts.set(state.contextId, { active: false });
  }
}

function backgroundWorkerSessionSafe(ses) { return !unsafeSessions.has(ses); }

module.exports = { initializeBackgroundWorkers, allowBackgroundWorkers, protectBackgroundWorkers, backgroundWorkersProtected, quarantineBackgroundWorkers, backgroundWorkerSessionSafe };
