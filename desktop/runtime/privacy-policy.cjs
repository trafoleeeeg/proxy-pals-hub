const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { profileId } = require("./validation.cjs");

// Exact origins only. No wildcards, subdomain inheritance or cloud-controlled
// exceptions. Permissions do not follow a profile to another physical device.
function privacyOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.origin;
  } catch { return ""; }
}

function createPrivacyStore({ safeStorage, userData, extensions = false }) {
  const root = path.join(userData, extensions ? "profile-extension-consent" : "profile-privacy");
  const valid = extensions
    ? (value) => typeof value === "string" && /^[a-f0-9]{24}$/.test(value)
    : (value) => typeof value === "string" && !!value && privacyOrigin(value) === value;
  const available = () => safeStorage?.isEncryptionAvailable?.()
    && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  const file = (id) => path.join(root, `${profileId(id)}.bin`);
  return {
    async read(id) {
      if (!available()) return [];
      try {
        const target = file(id);
        if ((await fs.stat(target)).size > 131072) return [];
        const data = JSON.parse(safeStorage.decryptString(await fs.readFile(target)));
        if (data.version !== 1 || data.profileId !== profileId(id) || !Array.isArray(data.origins)) return [];
        return [...new Set(data.origins.filter(valid))].slice(0, 100);
      } catch { return []; } // A damaged/missing policy never grants exceptions.
    },
    async write(id, origins) {
      if (!available()) throw new Error("Не удалось зашифровать настройки защиты");
      if (!Array.isArray(origins) || origins.length > 100 || origins.some((origin) => !valid(origin))) throw new Error("Некорректное исключение защиты");
      const target = file(id), temporary = target + "." + randomUUID() + ".tmp";
      let handle;
      try {
        const payload = JSON.stringify({ version: 1, profileId: profileId(id), origins: [...new Set(origins)] });
        await fs.mkdir(root, { recursive: true });
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(safeStorage.encryptString(payload));
        await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temporary, target);
      } catch { throw new Error("Не удалось сохранить настройки защиты"); }
      finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
    },
  };
}

module.exports = { privacyOrigin, createPrivacyStore };
