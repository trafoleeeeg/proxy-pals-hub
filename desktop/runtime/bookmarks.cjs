const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { profileId, startUrl } = require("./validation.cjs");

const MAX_BOOKMARKS = 64;
const MAX_BYTES = 256 * 1024;
const MAX_FAVICON_BYTES = 64 * 1024;
const FAVICON_PATTERN = /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,([a-z\d+/]+={0,2})$/i;

function sanitizeFavicon(value) {
  if (typeof value !== "string") return "";
  const match = value.match(FAVICON_PATTERN);
  if (!match) return "";
  const encoded = match[1];
  if (encoded.length > Math.ceil(MAX_FAVICON_BYTES / 3) * 4) return "";
  let bytes;
  try { bytes = Buffer.from(encoded, "base64"); } catch { return ""; }
  if (!bytes.length || bytes.length > MAX_FAVICON_BYTES || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return "";
  return value;
}

function sanitizeBookmarks(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value) {
    if (list.length >= MAX_BOOKMARKS) break;
    if (!item || typeof item !== "object") continue;
    let url;
    try { url = startUrl(typeof item.url === "string" ? item.url : ""); }
    catch { continue; }
    if (list.some((saved) => saved.url === url)) continue;
    const title = typeof item.title === "string" ? item.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) : "";
    const id = typeof item.id === "string" && /^[0-9a-f-]{36}$/i.test(item.id) ? item.id : randomUUID();
    const favicon = sanitizeFavicon(item.favicon);
    list.push({ id, url, title: title || new URL(url).hostname, ...(favicon ? { favicon } : {}) });
  }
  return list;
}

function sanitizeBookmarkState(value) {
  if (Array.isArray(value)) return { bookmarks: sanitizeBookmarks(value), barVisible: true };
  return {
    bookmarks: sanitizeBookmarks(value?.bookmarks),
    barVisible: typeof value?.barVisible === "boolean" ? value.barVisible : true,
  };
}

// Стартовый набор закладок для нового профиля. Пользователь может их
// переименовать, изменить адрес или удалить — повторно они не добавляются.
const DEFAULT_BOOKMARKS = [
  { title: "fb acc", url: "https://accountscenter.facebook.com/" },
  { title: "facebook", url: "https://www.facebook.com/" },
  { title: "facebook ads", url: "https://adsmanager.facebook.com/adsmanager/manage/campaigns" },
  { title: "google ads", url: "https://ads.google.com/aw/campaigns" },
  { title: "tiktok ads", url: "https://ads.tiktok.com/i18n/perf/creative" },
  { title: "tiktok", url: "https://www.tiktok.com/" },
  { title: "gmail почта", url: "https://mail.google.com/mail/u/0/" },
];

function defaultBookmarks() {
  return sanitizeBookmarks(DEFAULT_BOOKMARKS);
}

// Profile bookmarks stay on this device only: encrypted with the OS key store
// and never uploaded together with the profile's browsing session.
function createBookmarkStore({ safeStorage, userData }) {
  const root = path.join(userData, "profile-bookmarks");
  function available() {
    return !!safeStorage?.isEncryptionAvailable?.()
      && !(safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === "basic_text");
  }
  function filename(id) { return path.join(root, `${profileId(id)}.bin`); }
  return {
    async readState(id) {
      const empty = { bookmarks: [], barVisible: true, stored: false };
      if (!available()) return empty;
      let encrypted;
      try {
        const file = filename(id);
        const stat = await fs.stat(file);
        if (stat.size > MAX_BYTES + 65536) return empty;
        encrypted = await fs.readFile(file);
      } catch { return empty; }
      try {
        const data = JSON.parse(safeStorage.decryptString(encrypted));
        if (![1, 2].includes(data.version) || data.profileId !== profileId(id)) return empty;
        return { ...sanitizeBookmarkState(data.version === 1 ? data.bookmarks : data), stored: true };
      } catch { return empty; }
    },
    async read(id) {
      return (await this.readState(id)).bookmarks;
    },
    async write(id, value) {
      const state = sanitizeBookmarkState(value);
      if (!available()) return Array.isArray(value) ? state.bookmarks : state;
      const payload = JSON.stringify({ version: 2, profileId: profileId(id), ...state });
      if (Buffer.byteLength(payload) > MAX_BYTES) return Array.isArray(value) ? state.bookmarks : state;
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
      } catch { throw new Error("Не удалось сохранить зашифрованные закладки"); }
      finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
      return Array.isArray(value) ? state.bookmarks : state;
    },
    async remove(id) { await fs.unlink(filename(id)).catch(() => {}); },
  };
}

module.exports = { createBookmarkStore, sanitizeBookmarks, sanitizeBookmarkState, sanitizeFavicon, defaultBookmarks, DEFAULT_BOOKMARKS, MAX_BOOKMARKS, MAX_FAVICON_BYTES };
