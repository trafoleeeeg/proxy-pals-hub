const fs = require("node:fs");
const path = require("node:path");
const { connectBrowserProtocol } = require("./browser-pipe.cjs");
const documentSource = fs.readFileSync(path.join(__dirname, "..", "fingerprint-preload.cjs"), "utf8");
const sessions = new WeakMap();
const contexts = new Map();
const targets = new Map();
const terminations = new Map();
const shutdownTargets = new Map();
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

function finishTermination(record) {
  const pending = terminations.get(record.targetId);
  if (!pending?.destroyed || !pending.connectionsClosed) return;
  clearTimeout(pending.timer);
  terminations.delete(record.targetId);
  record.state?.terminating.delete(record.targetId);
  if (record.state?.active) diagnose(record.state, pending.requested ? "setup-failed" : "worker-retired", record, "worker-closed");
}

function awaitTermination(record, requested = false) {
  if (terminations.has(record.targetId) || !record.state?.active) return;
  const state = record.state;
  const pending = { record, requested, destroyed: false, connectionsClosed: false };
  terminations.set(record.targetId, pending);
  // A retiring SW reports Inspector.targetCrashed before Target.targetDestroyed.
  // Suspend outbound traffic until terminal destruction is confirmed; detach
  // and closeTarget.success alone do not prove that the worker cannot restart.
  state.terminating.add(record.targetId);
  pending.timer = setTimeout(() => fail(state, requested ? "close-failed" : "termination-unconfirmed", record), 1000);
  pending.timer.unref?.();
  void state.ses.closeAllConnections().then(() => {
    pending.connectionsClosed = true;
    finishTermination(record);
  }, () => fail(state, "close-failed", record));
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
  const ensureCurrent = () => {
    if (record.cancelled || record.epoch !== epoch || record.phase !== "starting") throw new Error("Worker incarnation ended");
  };
  const send = (method, args, sessionId) => {
    ensureCurrent();
    record.stage = method;
    return protocol.send(method, args, sessionId);
  };
  try {
    const state = record.state || await findContext(info.browserContextId);
    record.state = state;
    ensureCurrent();
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
    ensureCurrent();
    if (!state.active || state.fp !== fp) return;
    // A resume timeout is ambiguous: Chromium may already have executed code.
    record.resuming = true;
    await send("Runtime.runIfWaitingForDebugger", {}, id);
    ensureCurrent();
    record.phase = "running";
  } catch {
    if (record.cancelled || record.phase === "stopped" || record.epoch !== epoch) return;
    // A target held behind `waitForDebugger` has not executed site code yet.
    // CDP setup can transiently fail while Chromium is creating a worker. Keep
    // its record and network gate until terminal destruction is confirmed.
    // closeTarget.success means only that the stop request was accepted.
    if (waitingForDebugger && !record.resuming) {
      record.closing = true;
      awaitTermination(record, true);
      try {
        const closed = await protocol.send("Target.closeTarget", { targetId: info.targetId });
        if (closed.success !== true) throw new Error("Worker closure not confirmed");
        return;
      } catch {
        if (!record.destroyed) fail(record.state, "close-failed", record);
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
          ++record.epoch;
          // This also describes a normally retired SW version. Only terminal
          // target destruction allows traffic again; in-place restart is unsafe.
          if (record.info.type === "service_worker" && !record.cancelled) {
            if (record.state?.redundantTargets?.has(record.targetId)) {
              record.retired = true;
              diagnose(record.state, "worker-retired", record, "worker-closed");
            } else awaitTermination(record, record.closing);
          }
          if (record.closing && !record.cancelled) {
            void protocol.send("Target.detachFromTarget", { sessionId: record.id }).catch(() => {
              if (!record.destroyed) fail(record.state, "close-failed", record);
            });
          }
        }
      }
      if (method === "Inspector.targetReloadedAfterCrash") {
        const record = targets.get(parentSessionId);
        if (record?.phase === "stopped" && record.info.type === "service_worker") fail(record.state, "worker-restarted", record);
        if (record?.phase === "stopped" && record.info.type === "shared_worker" && !record.cancelled && record.state?.active) {
          void configureWorker({ sessionId: record.id, targetInfo: record.info, waitingForDebugger: true }, null, record);
        }
      }
      if (method === "Target.detachedFromTarget") {
        const record = targets.get(params.sessionId);
        if (record) {
          record.cancelled = true; ++record.epoch;
          record.state?.redundantTargets?.delete(record.targetId);
        }
        targets.delete(params.sessionId);
      }
      if (method === "Target.targetDestroyed") {
        const shutdown = shutdownTargets.get(params.targetId);
        if (shutdown) { shutdownTargets.delete(params.targetId); shutdown.resolve(); }
        const record = terminations.get(params.targetId)?.record || [...targets.values()].find((item) => item.targetId === params.targetId);
        if (record) {
          record.destroyed = true;
          record.state?.redundantTargets?.delete(record.targetId);
          for (const [versionId, targetId] of record.state?.workerVersions || []) {
            if (targetId === record.targetId) record.state.workerVersions.delete(versionId);
          }
          record.cancelled = true;
          ++record.epoch;
          targets.delete(record.id);
          const pending = terminations.get(params.targetId);
          if (pending) { pending.destroyed = true; finishTermination(record); }
        }
      }
    });
    protocol.on("disconnect", () => { for (const state of contexts.values()) fail(state, "protocol-disconnect"); });
    await protocol.send("Target.setDiscoverTargets", { discover: true,
      filter: [{ type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }, { exclude: true }],
    });
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
  const state = { ses, guard, wc, active: false, fp: null, onFailure: null, terminating: new Set(), redundantTargets: new Set(), workerVersions: new Map() };
  sessions.set(ses, state);
  state.ready = (async () => { try {
    await wc.loadURL("about:blank");
    wc.debugger.attach("1.3");
    const { targetInfo } = await wc.debugger.sendCommand("Target.getTargetInfo");
    if (!targetInfo.browserContextId) throw new Error("Missing browser context identity");
    state.contextId = targetInfo.browserContextId;
    contexts.set(state.contextId, state);
    let snapshotReady;
    let snapshotTimer;
    const snapshot = new Promise((resolve, reject) => {
      snapshotReady = () => { clearTimeout(snapshotTimer); resolve(); };
      snapshotTimer = setTimeout(() => reject(new Error("Worker lifecycle snapshot unavailable")), 10000);
      snapshotTimer.unref?.();
    });
    wc.debugger.on("message", (_event, method, params) => {
      if (method !== "ServiceWorker.workerVersionUpdated") return;
      for (const version of params.versions || []) {
        if (version.targetId) state.workerVersions.set(version.versionId, version.targetId);
        const targetId = state.workerVersions.get(version.versionId);
        if (version.status === "redundant") {
          if (targetId && [...targets.values()].some(record => record.targetId === targetId && record.state === state)) state.redundantTargets.add(targetId);
          state.workerVersions.delete(version.versionId);
        }
      }
      snapshotReady();
    });
    try { await Promise.all([snapshot, wc.debugger.sendCommand("ServiceWorker.enable")]); }
    finally { clearTimeout(snapshotTimer); }
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
  for (const targetId of state.terminating) {
    clearTimeout(terminations.get(targetId)?.timer);
    terminations.delete(targetId);
  }
  state.terminating.clear();
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    const owned = [...targets.values()].filter((record) => record.state === state);
    for (const record of owned) record.cancelled = true;
    // A debugger-held worker can prevent stopAllWorkers/closeTarget replying.
    // Dispatch stop AND detach concurrently; never wait for stop before detach.
    // The SW domain's completion confirms stopped executions, not registrations.
    // Shared workers additionally require target destruction, not close.success.
    const sharedStopped = owned.filter(record => record.info.type === "shared_worker" && !record.destroyed)
      .map(record => new Promise(resolve => shutdownTargets.set(record.targetId, { resolve })));
    const servicesStopped = state.wc.debugger.sendCommand("ServiceWorker.stopAllWorkers");
    for (const record of owned) {
      void protocol.send("Target.closeTarget", { targetId: record.targetId }).catch(() => {});
      void protocol.send("Target.detachFromTarget", { sessionId: record.id }).catch(() => {});
    }
    await Promise.all([servicesStopped, ...sharedStopped]);
    // The partition-aware cookie reader must survive until the final durable
    // snapshot/outbox after workers stop. Its about:blank target has no website
    // scripts and stays on this session's already blocked network gate.
    if (!state.cookieLease) { state.wc.close(); state.guard = null; }
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
  return { stop: () => stopState(state), isActive: () => state.active && state.terminating.size === 0 };
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

function cookieProtocolForSession(ses) {
  const state = sessions.get(ses);
  if (!protocol || !state?.contextId) throw new Error("Cookie partition transport unavailable");
  // Electron does not expose its persisted contexts through root Storage.*.
  // Network.* on the existing session-owned blank target is scoped by the
  // target's actual StoragePartition. Never fall back to the default context.
  state.cookieLease = true;
  const send = (method, params = {}) => {
    if (state.wc.isDestroyed() || !state.wc.debugger.isAttached()) throw Object.assign(new Error("Cookie partition transport unavailable"), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
    return state.wc.debugger.sendCommand(method, params);
  };
  return {
    read: () => send("Network.getAllCookies"),
    write: (cookies) => send("Network.setCookies", { cookies }),
    dispose: () => {
      state.cookieLease = false;
      if (!state.active && !state.wc.isDestroyed()) { state.wc.close(); state.guard = null; }
    },
  };
}

module.exports = { initializeBackgroundWorkers, allowBackgroundWorkers, protectBackgroundWorkers, backgroundWorkersProtected, quarantineBackgroundWorkers, backgroundWorkerSessionSafe, cookieProtocolForSession };
