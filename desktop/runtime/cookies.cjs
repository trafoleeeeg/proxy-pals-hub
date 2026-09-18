const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { profileId, revision } = require("./validation.cjs");
const MAX_BYTES = 8 * 1024 * 1024;

function parseCookies(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Invalid cookie snapshot size");
  let cookies;
  try { cookies = JSON.parse(raw); } catch { throw new Error("Invalid cookie snapshot"); }
  if (!Array.isArray(cookies) || cookies.length > 10000) throw new Error("Invalid cookie snapshot");
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object" || typeof cookie.name !== "string" || typeof cookie.value !== "string" || typeof cookie.domain !== "string" || !cookie.domain || /[\s/@\\?#]/.test(cookie.domain) || (cookie.path != null && (typeof cookie.path !== "string" || !cookie.path.startsWith("/")))) throw new Error("Invalid cookie entry");
    if (cookie.expirationDate != null && !Number.isFinite(cookie.expirationDate)) throw new Error("Invalid cookie expiration");
  }
  return cookies;
}

function canonicalCookies(cookies) {
  return JSON.stringify(cookies.map((cookie) => Object.fromEntries(Object.entries(cookie).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => `${a.domain}\0${a.path}\0${a.name}\0${JSON.stringify(a.partitionKey)}`.localeCompare(`${b.domain}\0${b.path}\0${b.name}\0${JSON.stringify(b.partitionKey)}`)));
}

async function restoreCookies(ses, cookies) {
  // Replace, including removals; merging would revive cookies deleted elsewhere.
  await ses.clearStorageData({ storages: ["cookies"] });
  let restored = 0;
  let skipped = 0;
  for (const cookie of cookies) {
    if (cookie.expirationDate != null && cookie.expirationDate <= Date.now() / 1000) continue;
    const host = cookie.domain.replace(/^\./, "");
    const details = {
      url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
      name: cookie.name, value: cookie.value, path: cookie.path || "/",
      secure: !!cookie.secure, httpOnly: !!cookie.httpOnly,
    };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (!cookie.session && cookie.expirationDate != null) details.expirationDate = cookie.expirationDate;
    if (cookie.sameSite) details.sameSite = cookie.sameSite;
    try {
      await ses.cookies.set(details);
      restored += 1;
    } catch {
      // Chromium occasionally rejects obsolete or origin-incompatible cookies
      // from an older snapshot. One bad entry must not prevent the profile from
      // opening or discard every other valid cookie.
      skipped += 1;
    }
  }
  await ses.cookies.flushStore();
  return { restored, skipped };
}

function createCookieStore({ safeStorage, userData }) {
  const root = path.join(userData, "profile-cookie-snapshots");
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable() || (safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error("OS cookie encryption is unavailable");
  }
  function filename(id) { return path.join(root, `${profileId(id)}.bin`); }
  return {
    async read(id) {
      requireEncryption();
      let encrypted;
      try {
        const file = filename(id);
        const stat = await fs.stat(file);
        if (stat.size > MAX_BYTES + 65536) throw new Error("Oversized snapshot");
        encrypted = await fs.readFile(file);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("Unable to read encrypted cookie snapshot");
      }
      try {
        const data = JSON.parse(safeStorage.decryptString(encrypted));
        if (data.version !== 1 || data.profileId !== profileId(id) || !revision(data.cookiesUpdatedAt)) throw new Error("Invalid snapshot");
        return { cookies: parseCookies(data.cookies), cookiesUpdatedAt: revision(data.cookiesUpdatedAt) };
      } catch { throw new Error("Unable to decrypt cookie snapshot; local data was preserved"); }
    },
    async write(id, cookies, cookiesUpdatedAt) {
      requireEncryption();
      const serialized = canonicalCookies(cookies);
      parseCookies(serialized);
      const file = filename(id);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, profileId: profileId(id), cookies: serialized, cookiesUpdatedAt: revision(cookiesUpdatedAt) }));
        await fs.mkdir(root, { recursive: true });
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(encrypted);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, file);
      } catch { throw new Error("Unable to save encrypted cookie snapshot"); }
      finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    },
    async remove(id) { await fs.unlink(filename(id)).catch((error) => { if (error.code !== "ENOENT") throw new Error("Unable to delete cookie snapshot"); }); },
  };
}

async function initializeCookies(ses, store, payload) {
  const local = await store.read(payload.profileId);
  const cloudRevision = revision(payload.cookiesUpdatedAt);
  let selected;
  let source;
  if (local && (!cloudRevision || Date.parse(cloudRevision) <= Date.parse(local.cookiesUpdatedAt))) {
    selected = local;
    source = "local";
  } else if (local || cloudRevision) {
    selected = { cookies: parseCookies(payload.cookies ?? "[]"), cookiesUpdatedAt: cloudRevision };
    source = "cloud";
  } else {
    const existing = await ses.cookies.get({});
    selected = { cookies: existing.length ? existing : parseCookies(payload.cookies ?? "[]"), cookiesUpdatedAt: null };
    source = existing.length ? "native-disk" : "cloud";
  }
  const restoreResult = await restoreCookies(ses, selected.cookies);
  const cookies = await ses.cookies.get({});
  const cookiesUpdatedAt = selected.cookiesUpdatedAt || new Date().toISOString();
  await store.write(payload.profileId, cookies, cookiesUpdatedAt);
  return { cookiesUpdatedAt, signature: canonicalCookies(cookies), source, skippedCookies: restoreResult.skipped };
}

module.exports = { createCookieStore, initializeCookies, canonicalCookies, parseCookies, restoreCookies };
