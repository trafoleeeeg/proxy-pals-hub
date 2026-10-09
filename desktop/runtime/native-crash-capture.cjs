const fs = require("node:fs");
const path = require("node:path");
const { recordProcessEvent } = require("./process-diagnostics.cjs");

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DUMPS = 3;
const MAX_BYTES = 128 * 1024 * 1024;
const DUMP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.dmp$/i;

// Explicit machine-local consent only. No web/IPC switch, environment opt-in,
// remote upload or default collection on other users' installations.
function validateConsent(value, now = Date.now()) {
  if (!value || value.enabled !== true || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt <= now || value.expiresAt > now + MAX_AGE_MS) return null;
  const directory = value.directory;
  if (typeof directory !== "string" || directory.length > 240
      || !/^[a-z]:[\\/]/i.test(directory) || /[\x00-\x1f]/.test(directory)
      || directory.slice(2).includes(":")) return null;
  const parts = directory.slice(3).split(/[\\/]/);
  if (parts.length < 2 || parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))
      || parts.at(-1).toLowerCase() !== "umbra-native-crashes") return null;
  return { directory: path.win32.normalize(directory), expiresAt: value.expiresAt };
}

function hasLink(directory) {
  // Never follow junctions out of the explicitly provisioned private folder.
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function pruneDumps(directory, now = Date.now()) {
  const dumps = [];
  for (const leaf of [directory, ...["reports", "pending", "completed"].map(name => path.join(directory, name))]) {
    if (!fs.existsSync(leaf) || fs.lstatSync(leaf).isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(leaf, { withFileTypes: true })) {
      if (!entry.isFile() || !DUMP_NAME.test(entry.name)) continue;
      const file = path.join(leaf, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isFile()) dumps.push({ file, size: stat.size, time: stat.mtimeMs });
    }
  }
  dumps.sort((a, b) => b.time - a.time);
  let bytes = 0, retained = 0, removed = 0;
  for (const dump of dumps) {
    bytes += dump.size;
    retained++;
    // Leave the newest dump and any still-being-written file intact. Limits
    // are best-effort retention, never a reason to terminate a browser.
    if (retained === 1 || now - dump.time < 120000) continue;
    if (retained <= MAX_DUMPS && bytes <= MAX_BYTES && now - dump.time <= MAX_AGE_MS) continue;
    try {
      fs.unlinkSync(dump.file);
      removed++;
      bytes -= dump.size;
      retained--;
      const meta = dump.file.replace(/\.dmp$/i, ".meta");
      if (fs.existsSync(meta) && fs.lstatSync(meta).isFile() && !fs.lstatSync(meta).isSymbolicLink()) fs.unlinkSync(meta);
    } catch { /* A locked Crashpad report is left for the next sweep. */ }
  }
  return removed;
}

function startNativeCrashCapture(electron, role, options = {}) {
  const { app, crashReporter } = electron;
  if ((options.platform || process.platform) !== "win32") return false;
  let userData;
  const status = state => recordProcessEvent(userData, "native-crash-capture", { state });
  try {
    userData = app.getPath("userData");
    const config = path.join(userData, "diagnostics", "native-crash-capture.json");
    if (!fs.existsSync(config)) return false;
    const stat = fs.lstatSync(config);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) { status("rejected"); return false; }
    const consent = validateConsent(JSON.parse(fs.readFileSync(config, "utf8")));
    if (!consent || !["coordinator", "browser"].includes(role)) { status("rejected"); return false; }
    const root = consent.directory;
    if (!fs.lstatSync(root).isDirectory() || hasLink(root)) { status("rejected"); return false; }
    const directory = path.join(root, role);
    fs.mkdirSync(directory, { recursive: true });
    if (hasLink(directory)) { status("rejected"); return false; }
    app.setPath("crashDumps", directory);
    // Do not include command lines, profile identity or any session annotations.
    crashReporter.start({ productName: "Umbra", uploadToServer: false, extra: {}, globalExtra: {} });
    if (crashReporter.getUploadToServer()) {
      crashReporter.setUploadToServer(false);
      status("failed");
      return false;
    }
    status("enabled");
    const sweep = () => {
      try { if (pruneDumps(directory)) status("pruned"); } catch { /* No raw error logging. */ }
    };
    sweep();
    const timer = setInterval(sweep, 60000);
    timer.unref();
    app.once("will-quit", () => clearInterval(timer));
    return true;
  } catch { status("failed"); return false; }
}

module.exports = { validateConsent, pruneDumps, startNativeCrashCapture };
