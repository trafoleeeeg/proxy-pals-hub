const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { StringDecoder } = require("node:string_decoder");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { recordProcessEvent } = require("./process-diagnostics.cjs");
const { createNativeFatalParser } = require("./native-fatal-diagnostics.cjs");

const CHANNEL = "umbra:private-browser-protocol";
const CHILD = "UMBRA_PRIVATE_BROWSER_CHILD";
const MAX_MESSAGE = 16 * 1024 * 1024;

// Chromium's browser target is reachable through inherited anonymous pipes.
// No HTTP/WebSocket debugging listener, port file, or renderer IPC bridge.
function spawnBrowser(executable, args, options = {}, onPipeClose = () => {}) {
  const env = { ...process.env, ...options.env, [CHILD]: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const cleanArgs = args.filter((arg) => !/^--remote-debugging-(?:port|pipe|io-pipes)(?:=|$)/.test(arg));
  const child = spawn(executable, [...cleanArgs, "--remote-debugging-pipe"], {
    ...options, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "ipc"],
  });
  let buffer = "";
  let stopped = false;
  const decoder = new StringDecoder("utf8");
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    try { onPipeClose(reason); } catch { /* Diagnostics must not prevent pipe cleanup. */ }
    if (child.connected) child.send({ channel: CHANNEL, closed: true }, () => {});
    // Closing the private pipe asks Electron to quit through its normal
    // before-quit handler, which durably saves profiles and the cookie outbox.
    child.stdio[3].destroy();
    child.stdio[4].destroy();
  };
  const forward = (payload) => {
    if (child.connected) child.send({ channel: CHANNEL, payload }, (error) => { if (error) stop("ipc-send-failed"); });
  };
  child.stdio[4].on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > MAX_MESSAGE) { stop("read-message-too-large"); return; }
    let index;
    while ((index = buffer.indexOf("\0")) !== -1) {
      const record = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try { forward(JSON.parse(record)); } catch { stop("message-forward-failed"); return; }
    }
  });
  child.on("message", (message) => {
    if (message?.channel !== CHANNEL || !message.payload || child.stdio[3].destroyed) return;
    const record = JSON.stringify(message.payload);
    if (record.length > MAX_MESSAGE) { stop("write-message-too-large"); return; }
    child.stdio[3].write(record + "\0");
  });
  child.stdio[3].on("error", () => stop("write-error"));
  child.stdio[4].on("error", () => stop("read-error"));
  child.stdio[4].on("end", () => stop("read-end"));
  child.on("disconnect", () => stop("ipc-disconnect"));
  return child;
}

function superviseBrowser({ forwardOutput = false } = {}) {
  const { app, dialog } = require("electron");
  if (process.env[CHILD] === "1" && typeof process.send === "function") {
    delete process.env[CHILD];
    process.on("message", (message) => { if (message?.channel === CHANNEL && message.shutdown) app.quit(); });
    return false;
  }
  const persistentUserData = app.getPath("userData");
  const diagnose = (event, details) => recordProcessEvent(persistentUserData, event, details);
  diagnose("coordinator-start");
  // This outer process owns only the pipe. The child retains the normal
  // single-instance lock, updater, windows and profile persistence lifecycle.
  // Give the coordinator its own temporary storage so two Electron browser
  // processes never open the application's Local State or disk caches.
  const coordinatorData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-coordinator-"));
  app.setPath("userData", coordinatorData);
  app.setPath("sessionData", coordinatorData);
  const cleanup = () => { try { fs.rmSync(coordinatorData, { recursive: true, force: true }); } catch { /* Locked coordinator cache remains in the OS temp directory. */ } };
  app.on("will-quit", cleanup);
  const child = spawnBrowser(process.execPath, process.argv.slice(1), {},
    (reason) => diagnose("coordinator-pipe-closed", { reason }));
  diagnose("coordinator-child-start", { childPid: child.pid });
  const healthTimer = setInterval(() => {
    try {
      const memory = process.memoryUsage();
      diagnose("process-health", { role: "other", childPid: child.pid, rssMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576) });
    } catch { /* Health sampling is optional. */ }
  }, 60000);
  healthTimer.unref?.();
  child.stderr.on("data", createNativeFatalParser((category) => diagnose("coordinator-native-fatal", { category, childPid: child.pid })));
  if (forwardOutput) { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }
  else { child.stdout.resume(); child.stderr.resume(); }
  let finished = false;
  child.on("error", () => {
    clearInterval(healthTimer);
    diagnose("coordinator-child-error", { childPid: child.pid });
    finished = true;
    dialog.showErrorBox("Umbra", "Не удалось запустить защищённый браузерный процесс");
    app.exit(1);
  });
  child.on("exit", (code, signal) => {
    clearInterval(healthTimer);
    diagnose("coordinator-child-exit", { childPid: child.pid, exitCode: code, signal });
    finished = true; cleanup(); app.exit(code || 0);
  });
  app.on("before-quit", (event) => {
    if (finished) return;
    diagnose("coordinator-before-quit");
    event.preventDefault();
    if (child.connected) child.send({ channel: CHANNEL, shutdown: true }, () => {});
  });
  return true;
}

function connectBrowserProtocol() {
  if (typeof process.send !== "function" || !process.connected) throw new Error("Private browser channel unavailable");
  const events = new EventEmitter();
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  const disconnect = () => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) request.reject(new Error("Private browser channel closed"));
    pending.clear();
    events.emit("disconnect");
  };
  process.on("disconnect", disconnect);
  process.on("message", (message) => {
    if (message?.channel === CHANNEL && message.closed) { disconnect(); return; }
    if (message?.channel !== CHANNEL || !message.payload) return;
    const payload = message.payload;
    if (payload.id) {
      const request = pending.get(payload.id);
      pending.delete(payload.id);
      if (request) payload.error ? request.reject(new Error("Browser protocol command failed")) : request.resolve(payload.result);
    } else if (payload.method) events.emit("message", payload.method, payload.params, payload.sessionId);
  });
  events.send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Private browser channel closed")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser protection timeout: " + method)); }, 10000);
    timer.unref?.();
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(new Error(method + ": " + error.message)); },
    });
    process.send({ channel: CHANNEL, payload: { id, method, params, ...(sessionId ? { sessionId } : {}) } }, (error) => {
      if (error) disconnect();
    });
  });
  return events;
}

module.exports = { spawnBrowser, superviseBrowser, connectBrowserProtocol };
