const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const lock = require("../engine/font-bundle-lock.json");
// Session objects outlive profile windows. Never silently turn off an applied
// native policy when an existing partition is reopened with changed settings.
const policies = new WeakMap();

async function verifyFontBundle(directory) {
  const files = [];
  for (const font of lock.files) {
    const file = path.join(directory, font.file);
    const bytes = await fs.readFile(file);
    if (bytes.length !== font.bytes || createHash("sha256").update(bytes).digest("hex") !== font.sha256)
      throw new Error("Font isolation bundle integrity failed");
    files.push(file);
  }
  return files;
}

async function applyFontIsolation(ses, fp, { app, bundleDirectory } = {}) {
  const enabled = fp.fontIsolation === true;
  const existing = policies.get(ses);
  if (existing) {
    if (existing.enabled !== enabled) throw new Error("Font isolation mode changed; restart Umbra");
    await existing.ready;
    fp.nativeFontIsolation = enabled;
    return enabled;
  }
  const ready = (async () => {
    if (!enabled) return;
    if (typeof ses.setUmbraFontIsolation !== "function")
      throw new Error("Font isolation requires an updated native engine");
    const directory = bundleDirectory || (app?.isPackaged
      ? path.join(process.resourcesPath, "isolated-fonts")
      : path.join(__dirname, "..", "assets", "isolated-fonts"));
    let files;
    try { files = await verifyFontBundle(directory); }
    catch { throw new Error("Font isolation bundle is missing or damaged"); }
    try { await ses.setUmbraFontIsolation(files); }
    catch { throw new Error("Font isolation could not be applied; restart Umbra"); }
  })();
  // Keep rejected policies too: a failed launch must not downgrade to host
  // fonts on an automatic retry. The user must explicitly restart the app.
  policies.set(ses, { enabled, ready });
  await ready;
  fp.nativeFontIsolation = enabled;
  return enabled;
}

module.exports = { applyFontIsolation, verifyFontBundle };
