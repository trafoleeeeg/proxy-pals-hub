const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const bootId = randomUUID();
let sequence = 0;
const EVENTS = new Set([
  "browser-start", "browser-before-quit", "browser-will-quit", "browser-uncaught-exception",
  "coordinator-start", "coordinator-before-quit", "coordinator-child-start", "coordinator-child-error", "coordinator-child-exit",
  "coordinator-pipe-closed", "coordinator-native-fatal", "panel-bundle-fallback",
  "coordinator-disconnect", "renderer-gone", "child-process-gone",
  "profile-close-phase",
  "profile-cleanup-failed",
  "background-worker",
  "page-protection",
  "native-crash-capture",
  "profile-lifecycle", "profile-close-request", "profile-snapshot", "proxy-operation",
  "contents-lifecycle", "window-lifecycle", "ipc-operation", "browser-command", "power-state", "process-health", "update-state", "protection-command", "execution-context",
]);
const PHASES = new Set(["begin", "ready", "failed", "done", "cancelled", "starting", "running",
  "session", "fingerprint", "workers", "proxy", "cookies", "extensions", "tabs",
  "created", "close", "closed", "destroy", "show", "hide", "focus", "blur",
  "did-start-loading", "did-stop-loading", "did-finish-load", "dom-ready", "did-navigate",
  "did-navigate-in-page", "did-fail-load", "render-process-gone", "unresponsive", "responsive", "destroyed", "debugger-detached",
  "suspend", "resume", "shutdown", "lock-screen", "unlock-screen",
  "idle", "checking", "available", "not-available", "downloading", "downloaded", "error", "installing", "none"]);
const SOURCES = new Set(["api", "shell-close", "shell-renderer-gone", "last-tab-close", "last-tab-destroyed",
  "page-protection", "worker-protection", "app-quit", "extension-change", "privacy-change", "browser-command", "unknown"]);
const BROWSER_ACTIONS = new Set(["new", "home", "navigate", "back", "forward", "reload", "close-tab", "close-profile",
  "reopen-closed", "duplicate", "reorder-tabs", "import-cookies", "switch-proxy", "check-connection", "check-leaks",
  "toggle-proxy-failover", "enable-extension", "open-extension", "close-extension", "pin-extension", "manage-extensions",
  "set-site-privacy", "bookmark", "save-bookmark", "open-bookmark", "remove-bookmark", "add-bookmark", "update-bookmark",
  "reorder-bookmarks", "toggle-bookmark-bar", "zoom-in", "zoom-out", "zoom-reset"]);
const OPERATIONS = new Set(["snapshot", "switch", "check", "launch-profile", "close-profile", "profile-cookies",
  "acknowledge-profile-cookies", "reconcile-profile-cookie-save", "pending-profile-closures", "acknowledge-profile-closure",
  "archive-profile-closure", "check-proxy", "panel-ready", "browser-settings-push", "bookmark-defaults-push",
  "check-update", "download-update", "install-update", "extensions-add", "extensions-add-url", "extensions-update", "extensions-remove",
  "cookie-recovery-backups"]);
const ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOSPC", "ENOMEM", "EIO", "ECONNRESET", "ETIMEDOUT",
  "ERR_ABORTED", "COOKIE_RECOVERY_CONFLICT", "COOKIE_RECOVERY_FAILED"]);

// Rotate by UTC day AND size. Keep yesterday only until its individual rows
// reach 24 hours; prune only the inactive file, never rewrite a live append log.
function maintainProcessJournal(userData, { now = Date.now(), maxBytes = MAX_BYTES } = {}) {
  try {
    const directory = path.join(userData, "diagnostics");
    const file = path.join(directory, "process-events.jsonl");
    const older = file + ".old";
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (stat.size >= maxBytes || new Date(stat.mtimeMs).toISOString().slice(0, 10) !== new Date(now).toISOString().slice(0, 10)) {
        fs.rmSync(older, { force: true });
        fs.renameSync(file, older);
      }
    }
    if (fs.existsSync(older)) {
      const raw = fs.readFileSync(older, "utf8");
      const retained = raw.split("\n").filter(line => {
        try { const at = Date.parse(JSON.parse(line).at); return at > now - DAY_MS && at <= now; } catch { return false; }
      });
      const next = retained.length ? retained.join("\n") + "\n" : "";
      if (!next) fs.rmSync(older, { force: true });
      else if (next !== raw) fs.writeFileSync(older, next, "utf8");
    }
    return true;
  } catch { return false; }
}

function startProcessJournalMaintenance(userData) {
  maintainProcessJournal(userData);
  const timer = setInterval(() => maintainProcessJournal(userData), 60000);
  timer.unref?.();
  return () => clearInterval(timer);
}
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
const PAGE_STAGES = new Set([...WORKER_STAGES, "blank-init", "Page.enable", "Page.getFrameTree", "Runtime.getIsolateId",
  "Network.setUserAgentOverride", "Page.addScriptToEvaluateOnNewDocument", "Emulation.setDeviceMetricsOverride"]);

// This is deliberately an allowlist: never persist URLs, profile names, IPC
// payloads, command lines, cookies or arbitrary Electron error messages.
function recordProcessEvent(userData, event, details = {}, options = {}) {
  if (typeof userData !== "string" || !userData || !EVENTS.has(event)) return false;
  try {
    const row = { at: new Date().toISOString(), event, pid: process.pid, bootId, seq: ++sequence,
      uptimeMs: Math.round(process.uptime() * 1000) };
    for (const key of ["runId", "operationId"]) {
      if (typeof details[key] === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(details[key])) row[key] = details[key];
    }
    if (PHASES.has(details.phase) && ["profile-lifecycle", "profile-snapshot", "proxy-operation", "contents-lifecycle", "window-lifecycle", "ipc-operation", "browser-command", "power-state", "update-state", "protection-command"].includes(event)) row.phase = details.phase;
    if (event === "browser-command" && BROWSER_ACTIONS.has(details.action)) row.action = details.action;
    if (event === "execution-context") {
      if (["created", "destroyed", "cleared", "detached"].includes(details.phase)) row.phase = details.phase;
      if (["page", "iframe", "worker"].includes(details.targetType)) row.targetType = details.targetType;
      for (const key of ["named", "hasUniqueId", "accepted", "defaultWorld"]) if (typeof details[key] === "boolean") row[key] = details[key];
    }
    if (event === "protection-command") {
      if (PAGE_STAGES.has(details.stage)) row.stage = details.stage;
      if (["page", "worker", "shared_worker", "service_worker"].includes(details.targetType)) row.targetType = details.targetType;
    }
    if (SOURCES.has(details.source)) row.source = details.source;
    if (OPERATIONS.has(details.operation)) row.operation = details.operation;
    if (ERROR_CODES.has(details.errorCode)) row.errorCode = details.errorCode;
    if (event === "profile-lifecycle" && ["starting", "session", "fingerprint", "workers", "proxy", "cookies", "extensions", "tabs", "running"].includes(details.stage)) row.stage = details.stage;
    for (const key of ["elapsedMs", "tabCount", "profileCount", "pendingCount", "rssMb", "heapMb"]) {
      if (Number.isSafeInteger(details[key]) && details[key] >= 0 && details[key] <= Number.MAX_SAFE_INTEGER) row[key] = details[key];
    }
    if (Number.isSafeInteger(details.netError) && details.netError <= 0 && details.netError >= -10000) row.netError = details.netError;
    for (const key of ["closing", "mainFrame", "ok", "applied"]) if (typeof details[key] === "boolean") row[key] = details[key];
    if (typeof details.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(details.version)) row.version = details.version;
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
    if (event === "page-protection") {
      if (["blank-init-failed", "command-failed", "debugger-detached", "setup-failed"].includes(details.reason)) row.reason = details.reason;
      if (PAGE_STAGES.has(details.stage)) row.stage = details.stage;
      if (["page", "iframe", "worker"].includes(details.targetType)) row.targetType = details.targetType;
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
    // The fast path checks metadata only. Retention scans run once a minute,
    // except when a segment actually needs rotation.
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (stat.size >= maxBytes || new Date(stat.mtimeMs).toISOString().slice(0, 10) !== row.at.slice(0, 10)) {
        if (!maintainProcessJournal(userData, { maxBytes }) && stat.size >= maxBytes) return false;
      }
    }
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { encoding: "utf8", flag: "a" });
    return true;
  } catch {
    // Diagnostics must never interrupt a browser session or block shutdown.
    return false;
  }
}

function observeContents(contents, record, role) {
  // Capture native IDs while alive: querying a destroyed native wrapper from
  // its teardown callback can itself throw and obscure the original incident.
  const contentsId = contents.id;
  const emit = (phase, extra = {}) => { try { record("contents-lifecycle", { role, contentsId, phase, ...extra }); } catch { /* Diagnostics are optional. */ } };
  for (const phase of ["did-start-loading", "did-stop-loading", "did-finish-load", "dom-ready", "did-navigate", "did-navigate-in-page", "unresponsive", "responsive", "destroyed"]) contents.on(phase, () => emit(phase));
  contents.on("did-fail-load", (_event, netError, _description, _url, mainFrame) => emit("did-fail-load", { netError, mainFrame }));
  contents.debugger?.on("detach", () => emit("debugger-detached"));
}

module.exports = { recordProcessEvent, maintainProcessJournal, startProcessJournalMaintenance, observeContents, BROWSER_ACTIONS };
