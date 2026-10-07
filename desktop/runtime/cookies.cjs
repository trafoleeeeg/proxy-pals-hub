const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { profileId, revision } = require("./validation.cjs");
const { normalizeCookiePartition } = require("./cookie-partition.cjs");
const transports = new WeakMap();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BYTES = 5_000_000;
const MAX_COOKIES = 10000;

function assertSupportedPartition(cookie) {
  return normalizeCookiePartition(cookie || {});
}

function registerCookieTransport(ses, transport) { transports.set(ses, transport); }
function disposeCookieTransport(ses) { transports.get(ses)?.dispose?.(); transports.delete(ses); }
async function readSessionCookies(ses) {
  const transport = transports.get(ses);
  return transport ? parseCookies(JSON.stringify(await transport.read())) : ses.cookies.get({});
}
async function writeSessionCookie(ses, cookie) {
  const transport = transports.get(ses);
  if (transport) return transport.write(cookie);
  if (assertSupportedPartition(cookie)) throw new Error("Для CHIPS нужен обновлённый клиент с защищённым транспортом cookies");
  return ses.cookies.set(cookieDetails(cookie));
}

function parseCookies(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Invalid cookie snapshot size");
  let cookies;
  try { cookies = JSON.parse(raw); } catch { throw new Error("Invalid cookie snapshot"); }
  if (!Array.isArray(cookies) || cookies.length > MAX_COOKIES) throw new Error("Invalid cookie snapshot");
  for (const cookie of cookies) {
    const partitionKey = assertSupportedPartition(cookie);
    if (partitionKey) cookie.partitionKey = partitionKey;
    else delete cookie.partitionKey;
    if (!cookie || typeof cookie !== "object" || typeof cookie.name !== "string" || typeof cookie.value !== "string" || typeof cookie.domain !== "string" || !cookie.domain || /[\s/@\\?#]/.test(cookie.domain) || (cookie.path != null && (typeof cookie.path !== "string" || !cookie.path.startsWith("/")))) throw new Error("Invalid cookie entry");
    if (cookie.expirationDate != null && !Number.isFinite(cookie.expirationDate)) throw new Error("Invalid cookie expiration");
  }
  return cookies;
}

function sameSite(value) {
  if (value == null || value === "") return undefined;
  const normalized = String(value).toLowerCase().replace(/[ -]/g, "_");
  if (normalized === "none") return "no_restriction";
  if (["unspecified", "no_restriction", "lax", "strict"].includes(normalized)) return normalized;
  throw new Error("Некорректное значение SameSite");
}

function expiration(cookie) {
  const value = cookie.expirationDate ?? cookie.expiration ?? cookie.expires;
  if (value == null || value === "" || value === 0 || value === "0") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Некорректный срок действия cookie");
  // Некоторые экспортеры используют миллисекунды вместо секунд Unix.
  const seconds = number > 253_402_300_799 ? number / 1000 : number;
  if (seconds <= 0) return undefined;
  if (seconds > 253_402_300_799) throw new Error("Некорректный срок действия cookie");
  return seconds;
}

function normalizeImportedCookie(cookie) {
  if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) throw new Error("Некорректная запись cookie");
  const partitionKey = assertSupportedPartition(cookie);
  let domain = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
  if (!domain && typeof cookie.url === "string") {
    try { domain = new URL(cookie.url).hostname; } catch { throw new Error("Некорректный домен cookie"); }
  }
  const name = cookie.name;
  const value = cookie.value;
  const path = cookie.path == null || cookie.path === "" ? "/" : cookie.path;
  if (typeof name !== "string" || typeof value !== "string") throw new Error("Имя и значение cookie должны быть строками");
  if (name.length > 4096 || /[\x00-\x20\x7f;,=]/.test(name)) throw new Error("Некорректное имя cookie");
  if (value.length > 65536 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Некорректное значение cookie");
  if (domain.length > 253 || !/^(\.?[a-zA-Z0-9_-]+)(\.[a-zA-Z0-9_-]+)*$/.test(domain)) throw new Error("Некорректный домен cookie");
  if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/")) throw new Error("Некорректный путь cookie");
  const expirationDate = expiration(cookie);
  const session = cookie.session === true || expirationDate == null;
  return {
    name, value, domain, path,
    hostOnly: cookie.hostOnly == null ? !domain.startsWith(".") : cookie.hostOnly === true,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    session,
    ...(partitionKey ? { partitionKey } : {}),
    ...(session ? {} : { expirationDate }),
    ...(cookie.sameSite == null || cookie.sameSite === "" ? {} : { sameSite: sameSite(cookie.sameSite) }),
  };
}

function parseNetscapeCookies(raw) {
  const cookies = [];
  for (const original of raw.split(/\r?\n/)) {
    const line = original;
    if (!line.trim() || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const httpOnly = line.startsWith("#HttpOnly_");
    const fields = (httpOnly ? line.slice("#HttpOnly_".length) : line).split("\t");
    if (fields.length < 7) throw new Error("Некорректная строка Netscape cookies");
    const [domain, includeSubdomains, path, secure, expires, name, ...value] = fields;
    if (!/^(?:TRUE|FALSE)$/i.test(includeSubdomains) || !/^(?:TRUE|FALSE)$/i.test(secure)) throw new Error("Некорректная строка Netscape cookies");
    cookies.push(normalizeImportedCookie({
      domain, hostOnly: includeSubdomains.toUpperCase() !== "TRUE", path,
      secure: secure.toUpperCase() === "TRUE", httpOnly,
      expirationDate: expires, name, value: value.join("\t"),
    }));
    if (cookies.length > MAX_COOKIES) throw new Error("Слишком много cookies в файле");
  }
  return cookies;
}

function parseCookieImport(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Файл cookies пуст");
  if (Buffer.byteLength(raw) > MAX_IMPORT_BYTES) throw new Error("Файл cookies больше 5 МБ");
  let cookies;
  const content = raw.replace(/^\uFEFF/, "");
  const probe = content.trimStart();
  if (probe.startsWith("[") || probe.startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(probe.trimEnd()); } catch { throw new Error("Некорректный JSON cookies"); }
    const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
    if (!Array.isArray(list)) throw new Error("JSON должен содержать массив cookies");
    if (list.length > MAX_COOKIES) throw new Error("Слишком много cookies в файле");
    cookies = list.map(normalizeImportedCookie);
  } else {
    cookies = parseNetscapeCookies(content);
  }
  if (!cookies.length) throw new Error("В файле нет cookies");
  // Используем ту же строгую проверку, что и для локальных зашифрованных снимков.
  return parseCookies(JSON.stringify(cookies));
}

function canonicalCookies(cookies) {
  return JSON.stringify(cookies.map((cookie) => Object.fromEntries(Object.entries(cookie).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => `${a.domain}\0${a.path}\0${a.name}\0${JSON.stringify(a.partitionKey)}`.localeCompare(`${b.domain}\0${b.path}\0${b.name}\0${JSON.stringify(b.partitionKey)}`)));
}

function cookieDetails(cookie) {
  const host = cookie.domain.replace(/^\./, "");
  const details = {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name, value: cookie.value, path: cookie.path || "/",
    secure: !!cookie.secure, httpOnly: !!cookie.httpOnly,
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session && cookie.expirationDate != null) details.expirationDate = cookie.expirationDate;
  if (cookie.sameSite) details.sameSite = cookie.sameSite;
  return details;
}

function retainedCount(actual, imported) {
  const keyOf = (cookie) => JSON.stringify([
    cookie.domain.replace(/^\./, ""), cookie.path || "/", cookie.name, cookie.value,
    assertSupportedPartition(cookie) || null,
  ]);
  const remaining = new Map();
  for (const cookie of actual) {
    const key = keyOf(cookie);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  let count = 0;
  for (const cookie of imported) {
    const key = keyOf(cookie);
    const available = remaining.get(key) || 0;
    if (available) { remaining.set(key, available - 1); count += 1; }
  }
  return count;
}

async function restoreCookies(ses, cookies) {
  // Validate before clearing anything: never silently remove a partition key.
  for (const cookie of cookies) assertSupportedPartition(cookie);
  if (cookies.some(cookie => assertSupportedPartition(cookie)) && !transports.has(ses)) throw new Error("Для CHIPS нужен обновлённый клиент с защищённым транспортом cookies");
  // Prove that the complete partition-aware jar is readable before erasing it.
  if (transports.has(ses)) await readSessionCookies(ses);
  // Replace, including removals; merging would revive cookies deleted elsewhere.
  await ses.clearStorageData({ storages: ["cookies"] });
  let restored = 0;
  let skipped = 0;
  let expired = 0;
  for (const cookie of cookies) {
    if (cookie.expirationDate != null && cookie.expirationDate <= Date.now() / 1000) { skipped += 1; expired += 1; continue; }
    try {
      await writeSessionCookie(ses, cookie);
      restored += 1;
    } catch (error) {
      if (error?.code === "COOKIE_TRANSPORT_UNAVAILABLE") throw error;
      // Chromium occasionally rejects obsolete or origin-incompatible cookies
      // from an older snapshot. One bad entry must not prevent the profile from
      // opening or discard every other valid cookie.
      skipped += 1;
    }
  }
  await ses.cookies.flushStore();
  const actual = await readSessionCookies(ses);
  const chips = cookies.filter(cookie => assertSupportedPartition(cookie) && !(cookie.expirationDate != null && cookie.expirationDate <= Date.now() / 1000));
  if (retainedCount(actual, chips) !== chips.length) throw new Error("Не все CHIPS cookies восстановлены; исходный снимок сохранён");
  return { restored, skipped, expired, installed: retainedCount(actual, cookies) };
}

async function applyImportedCookies(ses, cookies) {
  for (const cookie of cookies) assertSupportedPartition(cookie);
  if (cookies.some(cookie => assertSupportedPartition(cookie)) && !transports.has(ses)) throw new Error("Для CHIPS нужен обновлённый клиент с защищённым транспортом cookies");
  for (const cookie of cookies) {
    if (cookie.expirationDate != null && cookie.expirationDate <= Date.now() / 1000) continue;
    try { await writeSessionCookie(ses, cookie); }
    catch (error) { if (error?.code === "COOKIE_TRANSPORT_UNAVAILABLE") throw error; /* Report cookies actually retained. */ }
  }
  await ses.cookies.flushStore();
  const imported = retainedCount(await readSessionCookies(ses), cookies);
  const skipped = cookies.length - imported;
  if (!imported) throw new Error("Не удалось импортировать ни одного cookie");
  return { imported, skipped };
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
        return { cookies: parseCookies(data.cookies), cookiesUpdatedAt: revision(data.cookiesUpdatedAt),
          ...(data.pending === true ? { pending: true, baseRevision: revision(data.baseRevision) } : {}) };
      } catch { throw new Error("Unable to decrypt cookie snapshot; local data was preserved"); }
    },
    async markClosed(id) {
      const saved = await this.read(id);
      if (saved?.pending) await this.write(id, saved.cookies, saved.cookiesUpdatedAt);
    },
    async write(id, cookies, cookiesUpdatedAt, recovery = {}) {
      requireEncryption();
      const serialized = canonicalCookies(cookies);
      parseCookies(serialized);
      const file = filename(id);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, profileId: profileId(id), cookies: serialized, cookiesUpdatedAt: revision(cookiesUpdatedAt),
          ...(recovery.pending === true ? { pending: true, baseRevision: revision(recovery.baseRevision) } : {}) }));
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
  // Clean local caches defer to an explicit cloud revision/import. An unclean
  // checkpoint instead remembers its exact cloud base: it is not just a cache.
  // Comparing wall clocks from different computers is never authoritative.
  if (local?.pending && local.cookiesUpdatedAt !== cloudRevision) {
    // Compare the known base revision, never clocks on different machines.
    // A changed cloud base might be a deliberate import or another device:
    // preserve both rather than silently overwriting either snapshot.
    if (local.baseRevision !== cloudRevision) throw new Error("Unclean cookie recovery conflict; local and cloud data preserved");
    selected = local;
    source = "local-recovery";
  } else if (cloudRevision) {
    selected = { cookies: parseCookies(payload.cookies ?? "[]"), cookiesUpdatedAt: cloudRevision };
    source = "cloud";
  } else if (local) {
    selected = local;
    source = "local";
  } else {
    const existing = await readSessionCookies(ses);
    selected = { cookies: existing.length ? existing : parseCookies(payload.cookies ?? "[]"), cookiesUpdatedAt: null };
    source = existing.length ? "native-disk" : "cloud";
  }
  const restoreResult = await restoreCookies(ses, selected.cookies);
  const cookies = await readSessionCookies(ses);
  // Never replace a nonempty cloud/local snapshot with an empty native jar.
  // Rejected or expired imports must remain recoverable for another attempt.
  if (selected.cookies.length && !restoreResult.installed) throw new Error("Unable to restore imported cookies: no cookies were accepted");
  const cookiesUpdatedAt = selected.cookiesUpdatedAt || new Date().toISOString();
  await store.write(payload.profileId, cookies, cookiesUpdatedAt, { pending: true, baseRevision: cloudRevision });
  return { cookiesUpdatedAt, signature: canonicalCookies(cookies), source, skippedCookies: restoreResult.skipped,
    cookieRestore: { installed: restoreResult.installed, total: selected.cookies.length, expired: restoreResult.expired } };
}

module.exports = { createCookieStore, initializeCookies, canonicalCookies, parseCookies, parseCookieImport, restoreCookies, applyImportedCookies, registerCookieTransport, readSessionCookies, disposeCookieTransport };
