const { sanitizeBookmarks } = require("./bookmarks.cjs");

function sanitizeBrowserSettings(value, expectedProfileId) {
  if (!value || typeof value !== "object" || value.profileId !== expectedProfileId) return null;
  const zoomLevel = Number(value.zoomLevel);
  const revision = Number(value.revision);
  if (!Number.isFinite(zoomLevel) || zoomLevel < -3 || zoomLevel > 5 || !Number.isInteger(revision) || revision < 0) return null;
  const extensions = Array.isArray(value.extensions) ? value.extensions.slice(0, 64).flatMap((item) => {
    if (!item || !/^[a-f0-9]{24}$/.test(String(item.id))) return [];
    if (typeof item.url !== "string" || !item.url.startsWith("https://") || item.url.length > 2048) return [];
    return [{ id: String(item.id), pinned: item.pinned === true, url: item.url }];
  }) : [];
  const activeProxyId = typeof value.activeProxyId === "string" && /^[0-9a-f-]{36}$/i.test(value.activeProxyId) ? value.activeProxyId : null;
  return { profileId: expectedProfileId, bookmarks: sanitizeBookmarks(value.bookmarks), bookmarkBarVisible: value.bookmarkBarVisible !== false,
    zoomLevel, extensions, activeProxyId, proxyFailover: value.proxyFailover === true, revision,
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}) };
}

module.exports = { sanitizeBrowserSettings };