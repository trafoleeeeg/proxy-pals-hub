const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { profileId } = require("./validation.cjs");
const PRIVACY_CAPABILITIES = Object.freeze(["gpu", "canvas", "audio", "fonts", "workers"]);

function validPermissions(value) {
  return Array.isArray(value) && value.length <= PRIVACY_CAPABILITIES.length
    && value.every((item) => PRIVACY_CAPABILITIES.includes(item))
    && new Set(value).size === value.length;
}

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
  const readData = async (id) => {
    if (!available()) return null;
    try {
      const target = file(id);
      if ((await fs.stat(target)).size > 131072) return null;
      const data = JSON.parse(safeStorage.decryptString(await fs.readFile(target)));
      return data.profileId === profileId(id) ? data : null;
    } catch { return null; }
  };
  const writeData = async (id, data) => {
    if (!available()) throw new Error("Не удалось зашифровать настройки защиты");
    const target = file(id), temporary = target + "." + randomUUID() + ".tmp";
    let handle;
    try {
      await fs.mkdir(root, { recursive: true });
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(safeStorage.encryptString(JSON.stringify({ ...data, profileId: profileId(id) })));
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, target);
    } catch { throw new Error("Не удалось сохранить настройки защиты"); }
    finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  };
  return {
    async read(id) {
      const data = await readData(id);
      if (data?.version === 1 && Array.isArray(data.origins)) return [...new Set(data.origins.filter(valid))].slice(0, 100);
      if (!extensions && data?.version === 2) {
        const rules = await this.readPermissions(id);
        return Object.keys(rules).filter((origin) => PRIVACY_CAPABILITIES.every((item) => rules[origin].includes(item)));
      }
      return []; // A damaged/missing policy never grants exceptions.
    },
    async write(id, origins) {
      if (!Array.isArray(origins) || origins.length > 100 || origins.some((origin) => !valid(origin))) throw new Error("Некорректное исключение защиты");
      await writeData(id, { version: 1, origins: [...new Set(origins)] });
    },
    async readPermissions(id) {
      if (extensions) return {};
      const data = await readData(id);
      if (data?.version === 1 && Array.isArray(data.origins)) {
        return Object.fromEntries([...new Set(data.origins.filter(valid))].slice(0, 100).map((origin) => [origin, [...PRIVACY_CAPABILITIES]]));
      }
      if (data?.version !== 2 || !Array.isArray(data.rules) || data.rules.length > 100) return {};
      const rules = Object.create(null);
      for (const rule of data.rules) {
        if (!rule || !valid(rule.origin) || !validPermissions(rule.permissions) || rules[rule.origin]) return {};
        if (rule.permissions.length) rules[rule.origin] = [...rule.permissions];
      }
      return rules;
    },
    async writePermissions(id, rules) {
      if (extensions || !rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("Некорректное исключение защиты");
      const entries = Object.entries(rules);
      if (entries.length > 100 || entries.some(([origin, permissions]) => !valid(origin) || !validPermissions(permissions))) throw new Error("Некорректное исключение защиты");
      await writeData(id, { version: 2, rules: entries.filter(([, permissions]) => permissions.length).map(([origin, permissions]) => ({ origin, permissions })) });
    },
  };
}

module.exports = { PRIVACY_CAPABILITIES, privacyOrigin, createPrivacyStore };
