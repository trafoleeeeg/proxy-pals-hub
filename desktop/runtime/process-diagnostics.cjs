const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_BYTES = 128 * 1024;
const EVENTS = new Set([
  "browser-start", "browser-before-quit", "browser-will-quit", "browser-uncaught-exception",
  "coordinator-start", "coordinator-before-quit", "coordinator-child-error", "coordinator-child-exit",
  "coordinator-pipe-closed", "coordinator-native-fatal", "panel-bundle-fallback",
  "coordinator-disconnect", "renderer-gone", "child-process-gone",
  "profile-close-phase",
  "profile-cleanup-failed",
  "background-worker",
  "native-crash-capture",
]);
const CLOSE_PHASES = new Set(["begin", "workers", "tabs", "cookies", "outbox", "done", "failed"]);
const ROLES = new Set(["panel", "profile-shell", "profile-tab", "other"]);
const REASONS = new Set([
  "clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed",
  "integrity-failure", "memory-eviction",
]);
const PROCESS_TYPES = new Set([
  "GPU", "Utility", "Zygote", "Sandbox helper", "Pepper Plugin", "Pepper Plugin Broker", "Unknown",
]);
const SIGNALS = new Set(["SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGINT", "SIGKILL", "SIGSEGV", "SIGTERM"]);
const PIPE_REASONS = new Set(["read-message-too-large", "write-message-too-large", "message-forward-failed",
  "ipc-send-failed", "write-error", "read-error", "read-end", "ipc-disconnect"]);
const FATAL_CATEGORIES = new Set(["native-fatal", "v8-oom"]);
const WORKER_REASONS = new Set(["setup-failed", "close-failed", "resume-failed", "started-unprotected", "worker-crashed", "worker-retired", "worker-restarted", "termination-unconfirmed", "protocol-disconnect"]);
const WORKER_STAGES = new Set(["context", "Inspector.enable", "Runtime.enable", "Emulation.setUserAgentOverride",
  "Emulation.setTimezoneOverride", "Emulation.setLocaleOverride", "Emulation.setHardwareConcurrencyOverride",
  "Runtime.evaluate", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);

// This is deliberately an allowlist: never persist URLs, profile names, IPC
// payloads, command lines, cookies or arbitrary Electron error messages.
function recordProcessEvent(userData, event, details = {}, options = {}) {
  if (typeof userData !== "string" || !userData || !EVENTS.has(event)) return false;
  try {
    const row = { at: new Date().toISOString(), event, pid: process.pid };
    if (ROLES.has(details.role)) row.role = details.role;
    if (event === "native-crash-capture" && ["enabled", "rejected", "failed", "pruned"].includes(details.state)) row.state = details.state;
    if (event === "profile-close-phase" && CLOSE_PHASES.has(details.phase)) row.phase = details.phase;
    if (event === "profile-cleanup-failed") {
      if (["workers", "connections", "proxy"].includes(details.operation)) row.operation = details.operation;
      if (Number.isSafeInteger(details.elapsedMs) && details.elapsedMs >= 0) row.elapsedMs = details.elapsedMs;
    }
    if (REASONS.has(details.reason)) row.reason = details.reason;
    if (event === "coordinator-pipe-closed" && PIPE_REASONS.has(details.reason)) row.reason = details.reason;
    if (event === "coordinator-native-fatal" && FATAL_CATEGORIES.has(details.category)) row.category = details.category;
    if (event === "background-worker") {
      if (WORKER_REASONS.has(details.reason)) row.reason = details.reason;
      if (WORKER_STAGES.has(details.stage)) row.stage = details.stage;
      if (["worker", "shared_worker", "service_worker"].includes(details.workerType)) row.workerType = details.workerType;
      if (["stopped", "worker-closed"].includes(details.outcome)) row.outcome = details.outcome;
    }
    if (PROCESS_TYPES.has(details.processType)) row.processType = details.processType;
    if (SIGNALS.has(details.signal)) row.signal = details.signal;
    // Node's Windows child-process exit codes are unsigned DWORDs. Preserve
    // the original number, including native statuses such as 0xC0000005.
    if (Number.isSafeInteger(details.exitCode) && details.exitCode >= -2147483648 && details.exitCode <= 4294967295) row.exitCode = details.exitCode;
    for (const key of ["childPid", "contentsId"]) {
      if (Number.isSafeInteger(details[key]) && details[key] > 0 && details[key] <= 2147483647) row[key] = details[key];
    }
    row.freeMemoryMb = Math.round(os.freemem() / 1048576);
    const directory = path.join(userData, "diagnostics");
    const file = path.join(directory, "process-events.jsonl");
    fs.mkdirSync(directory, { recursive: true });
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_BYTES;
    if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
      const older = file + ".old";
      fs.rmSync(older, { force: true });
      fs.renameSync(file, older);
    }
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { encoding: "utf8", flag: "a" });
    return true;
  } catch {
    // Diagnostics must never interrupt a browser session or block shutdown.
    return false;
  }
}

module.exports = { recordProcessEvent };
