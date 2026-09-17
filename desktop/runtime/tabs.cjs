const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { profileId, startUrl } = require("./validation.cjs");

const MAX_TABS = 32;
const MAX_BYTES = 512 * 1024;

function sanitizeTabs(value) {
  if (!Array.isArray(value)) return [];
  const tabs = [];
  for (const item of value) {
    if (tabs.length >= MAX_TABS) break;
    try { tabs.push(startUrl(typeof item === "string" ? item : "", { allowBlank: true })); }
    catch { /* skip unsupported or malformed entries */ }
  }
  return tabs;
}

// Open tab addresses stay on this device only: encrypted with the OS key store,
// never uploaded and never mixed with the profile's browsing session.
function createTabStore({ safeStorage, userData }) {
  const root = path.join(userData, "profile-tab-snapshots");
  function available() {
    return !!safeStorage?.isEncryptionAvailable?.()
      && !(safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === "basic_text");
  }
  function filename(id) { return path.join(root, `${profileId(id)}.bin`); }
  return {
    async read(id) {
      if (!available()) return { tabs: [], activeIndex: 0 };
      let encrypted;
      try {
        const file = filename(id);
        const stat = await fs.stat(file);
        if (stat.size > MAX_BYTES + 65536) return { tabs: [], activeIndex: 0 };
        encrypted = await fs.readFile(file);
      } catch { return { tabs: [], activeIndex: 0 }; }
      try {
        const data = JSON.parse(safeStorage.decryptString(encrypted));
        if (data.version !== 1 || data.profileId !== profileId(id)) return { tabs: [], activeIndex: 0 };
        const tabs = sanitizeTabs(data.tabs);
        const activeIndex = Number.isInteger(data.activeIndex) && data.activeIndex >= 0 && data.activeIndex < tabs.length ? data.activeIndex : 0;
        return { tabs, activeIndex };
      } catch { return { tabs: [], activeIndex: 0 }; }
    },
    async write(id, tabs, activeIndex = 0) {
      if (!available()) return;
      const list = sanitizeTabs(tabs);
      const payload = JSON.stringify({
        version: 1, profileId: profileId(id), tabs: list,
        activeIndex: Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < list.length ? activeIndex : 0,
      });
      if (Buffer.byteLength(payload) > MAX_BYTES) return;
      const file = filename(id);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        const encrypted = safeStorage.encryptString(payload);
        await fs.mkdir(root, { recursive: true });
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(encrypted);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, file);
      } catch { throw new Error("Unable to save encrypted tab snapshot"); }
      finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    },
    async remove(id) { await fs.unlink(filename(id)).catch(() => {}); },
  };
}

module.exports = { createTabStore, sanitizeTabs, MAX_TABS };
