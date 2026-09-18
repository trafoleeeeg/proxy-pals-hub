const { sanitizeBookmarks } = require("./bookmarks.cjs");

function sanitizeBrowserSettings(value, expectedProfileId) {
  if (!value || typeof value !== "object" || value.profileId !== expectedProfileId) return null;
  const zoomLevel = Number(value.zoomLevel);
  const revision = Number(value.revision);
  if (!Number.isFinite(zoomLevel) || zoomLevel < -3 || zoomLevel > 5 || !Number.isInteger(revision) || revision < 0) return null;
  const extensions = Array.isArray(value.extensions) ? value.extensions.slice(0, 64).flatMap((item) => {
    if (!item || !/^[a-f0-9]{24}$/.test(String(item.id))) return [];
    const source = typeof item.source === "string" && item.source.startsWith("https://") && item.source.length <= 2048 ? item.source : undefined;
    return [{ id: String(item.id), pinned: item.pinned === true, ...(source ? { source } : {}) }];
  }) : [];
  return { profileId: expectedProfileId, bookmarks: sanitizeBookmarks(value.bookmarks), bookmarkBarVisible: value.bookmarkBarVisible !== false,
    zoomLevel, extensions, revision, ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}) };
}

module.exports = { sanitizeBrowserSettings };