const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { profileId, revision } = require("./validation.cjs");
const { canonicalCookies, parseCookies } = require("./cookies.cjs");

const LIMIT = 17 * 1024 * 1024;
const RECEIPT_TTL = 30 * 60 * 1000;
const MAX_BACKUPS = 100;
const digest = value => createHash("sha256").update(value).digest("hex");
const failure = message => Object.assign(new Error(message), { code: "COOKIE_RECOVERY_FAILED" });
function normalized(snapshot) {
  if (!snapshot) return null;
  return { cookies: parseCookies(canonicalCookies(snapshot.cookies)), cookiesUpdatedAt: revision(snapshot.cookiesUpdatedAt),
    ...(snapshot.pending ? { pending: true, baseRevision: revision(snapshot.baseRevision) } : {}) };
}
function signature(snapshot) { return digest(JSON.stringify(normalized(snapshot))); }
function summary(snapshot) {
  return snapshot ? { revision: revision(snapshot.cookiesUpdatedAt), count: snapshot.cookies.length,
    activeCount: snapshot.cookies.filter(cookie => cookie.expirationDate == null || cookie.expirationDate > Date.now() / 1000).length } : null;
}
function recoveryRequest(request) {
  if (request == null) return null;
  if (!request || typeof request !== "object" || !["local", "cloud"].includes(request.source) ||
    (!!request.receiptId === !!request.backupId)) throw new Error("Invalid cookie recovery request");
  return { source: request.source, ...(request.receiptId ? { receiptId: profileId(request.receiptId) } : { backupId: profileId(request.backupId) }) };
}

function createCookieRecovery({ safeStorage, userData, now = Date.now }) {
  const root = path.join(userData, "profile-cookie-recovery");
  const receipts = new Map();
  const directory = id => path.join(root, profileId(id));
  const filename = (id, backupId) => path.join(directory(id), `${profileId(backupId)}.bin`);
  function encryption() {
    if (!safeStorage?.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new Error("OS cookie encryption is unavailable");
  }
  async function names(id) {
    try {
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid cookie recovery directory");
      const stat = await fs.lstat(directory(id));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid cookie recovery directory");
      return (await fs.readdir(directory(id))).filter(name => /^[0-9a-f-]{36}\.bin$/i.test(name));
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async function read(id, backupId) {
    encryption();
    const file = filename(id, backupId);
    await names(id);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error("Invalid encrypted cookie recovery backup");
    try {
      const record = JSON.parse(safeStorage.decryptString(await fs.readFile(file)));
      if (record.version !== 1 || record.profileId !== profileId(id) || record.backupId !== profileId(backupId) ||
        !revision(record.createdAt) || !["local", "cloud"].includes(record.selectedSource) || !record.cloud) throw new Error();
      return { ...record, local: normalized(record.local), cloud: normalized(record.cloud) };
    } catch { throw failure("Не удалось прочитать зашифрованный резерв cookies. Данные не заменены."); }
  }
  async function archive(id, local, cloud, source) {
    encryption();
    if ((await names(id)).length >= MAX_BACKUPS) throw failure("Резерв cookies заполнен. Данные не заменены.");
    const backupId = randomUUID();
    const record = { version: 1, profileId: profileId(id), backupId, createdAt: new Date(now()).toISOString(),
      selectedSource: source, local: normalized(local), cloud: normalized(cloud) };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > LIMIT - 65536) throw failure("Резерв cookies слишком большой. Данные не заменены.");
    const encrypted = safeStorage.encryptString(serialized);
    const file = filename(id, backupId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      await fs.mkdir(directory(id), { recursive: true });
      await names(id);
      // Original checkpoint and native jar remain untouched until BOTH
      // versions have been durably encrypted and authenticated on readback.
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, file);
      if (JSON.stringify(await read(id, backupId)) !== serialized) throw new Error();
      return backupId;
    } catch { throw failure("Не удалось сохранить зашифрованный резерв обеих версий cookies. Данные не заменены."); }
    finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
  function conflict(id, name, local, cloud, changed = false) {
    for (const [key, value] of receipts) if (now() - value.issuedAt > RECEIPT_TTL || value.profileId === id) receipts.delete(key);
    while (receipts.size >= 32) receipts.delete(receipts.keys().next().value);
    const receiptId = randomUUID();
    receipts.set(receiptId, { profileId: id, local: signature(local), cloud: signature(cloud), issuedAt: now() });
    const error = new Error(changed ? "Версии cookies изменились. Проверьте новый выбор восстановления." : "Unclean cookie recovery conflict; local and cloud data preserved");
    error.code = "COOKIE_RECOVERY_CONFLICT";
    error.recovery = { receiptId, name: typeof name === "string" ? name.slice(0, 200) : "Профиль", local: summary(local), cloud: summary(cloud), changed };
    return error;
  }
  return {
    async select(payload, local, cloud) {
      const id = profileId(payload.profileId);
      const request = recoveryRequest(payload.cookieRecovery);
      if (!request) {
        if (local?.pending && local.baseRevision !== cloud.cookiesUpdatedAt && canonicalCookies(local.cookies) !== canonicalCookies(cloud.cookies)) throw conflict(id, payload.name, local, cloud);
        return null;
      }
      if (!payload.lockToken || typeof payload.lockToken !== "string") throw failure("Для восстановления нужна новая блокировка профиля");
      let selected;
      if (request.receiptId) {
        const receipt = receipts.get(request.receiptId);
        if (!receipt || receipt.profileId !== id || now() - receipt.issuedAt > RECEIPT_TTL ||
          receipt.local !== signature(local) || receipt.cloud !== signature(cloud)) throw conflict(id, payload.name, local, cloud, true);
        selected = request.source === "local" ? local : cloud;
      } else {
        const saved = await read(id, request.backupId);
        selected = saved[request.source];
      }
      if (!selected) throw failure("Локальная версия cookies отсутствует. Данные не заменены.");
      const backupId = await archive(id, local, cloud, request.source);
      // A rollback is a NEW local edit, not proof that an old wall clock is
      // newer than the server. The fresh server revision remains its base.
      const updatedAt = new Date(Math.max(now(), Date.parse(local?.cookiesUpdatedAt || "") + 1 || 0,
        Date.parse(cloud.cookiesUpdatedAt || "") + 1 || 0)).toISOString();
      return { cookies: selected.cookies, cookiesUpdatedAt: updatedAt, source: `${request.source}-recovery-selected`, backupId };
    },
    async listBackups(id) {
      const entries = [];
      for (const name of await names(id)) {
        const record = await read(id, name.slice(0, -4));
        entries.push({ backupId: record.backupId, createdAt: record.createdAt, selectedSource: record.selectedSource,
          local: summary(record.local), cloud: summary(record.cloud) });
      }
      return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
module.exports = { createCookieRecovery, recoveryRequest };
