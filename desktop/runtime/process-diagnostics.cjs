const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_BYTES = 128 * 1024;
const EVENTS = new Set([
  "browser-start", "browser-before-quit", "browser-will-quit", "browser-uncaught-exception",
  "coordinator-start", "coordinator-before-quit", "coordinator-child-error", "coordinator-child-exit",
  "coordinator-disconnect", "renderer-gone", "child-process-gone",
]);
const ROLES = new Set(["panel", "profile-shell", "profile-tab", "other"]);
const REASONS = new Set([
  "clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed",
  "integrity-failure", "memory-eviction",
]);
const PROCESS_TYPES = new Set([
  "GPU", "Utility", "Zygote", "Sandbox helper", "Pepper Plugin", "Pepper Plugin Broker", "Unknown",
]);
const SIGNALS = new Set(["SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGINT", "SIGKILL", "SIGSEGV", "SIGTERM"]);

// This is deliberately an allowlist: never persist URLs, profile names, IPC
// payloads, command lines, cookies or arbitrary Electron error messages.
function recordProcessEvent(userData, event, details = {}, options = {}) {
  if (typeof userData !== "string" || !userData || !EVENTS.has(event)) return false;
  try {
    const row = { at: new Date().toISOString(), event, pid: process.pid };
    if (ROLES.has(details.role)) row.role = details.role;
    if (REASONS.has(details.reason)) row.reason = details.reason;
    if (PROCESS_TYPES.has(details.processType)) row.processType = details.processType;
    if (SIGNALS.has(details.signal)) row.signal = details.signal;
    for (const key of ["exitCode", "childPid", "contentsId"]) {
      if (Number.isSafeInteger(details[key]) && details[key] >= -2147483648 && details[key] <= 2147483647) row[key] = details[key];
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
