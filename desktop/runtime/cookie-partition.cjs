const PARTITION_COOKIE_ERROR = "Некорректный ключ CHIPS cookie. Нужен topLevelSite HTTP(S); непрозрачные ключи перенести нельзя.";

// Keep parity with src/lib/cookie-partition.ts; tested with shared fixtures.
function normalizeCookiePartition(cookie) {
  for (const flag of ["partitioned", "partitionKeyOpaque"]) if (cookie[flag] != null && typeof cookie[flag] !== "boolean") throw new Error(PARTITION_COOKIE_ERROR);
  if (cookie.partitionKeyOpaque === true) throw new Error(PARTITION_COOKIE_ERROR);
  const key = cookie.partitionKey;
  if (key == null) {
    if (cookie.partitioned === true) throw new Error(PARTITION_COOKIE_ERROR);
    return undefined;
  }
  if (typeof key !== "object" || Array.isArray(key)) throw new Error(PARTITION_COOKIE_ERROR);
  if (Object.keys(key).some(field => !["topLevelSite", "hasCrossSiteAncestor"].includes(field))
    || typeof key.topLevelSite !== "string" || /[\x00-\x20\x7f]/.test(key.topLevelSite) || cookie.secure !== true) throw new Error(PARTITION_COOKIE_ERROR);
  let site;
  try { site = new URL(key.topLevelSite); } catch { throw new Error(PARTITION_COOKIE_ERROR); }
  if (!["http:", "https:"].includes(site.protocol) || !site.hostname || site.username || site.password
    || site.port || site.pathname !== "/" || site.search || site.hash) throw new Error(PARTITION_COOKIE_ERROR);
  const bit = key.hasCrossSiteAncestor;
  if (bit !== undefined && typeof bit !== "boolean") throw new Error(PARTITION_COOKIE_ERROR);
  const domain = typeof cookie.domain === "string" ? cookie.domain.replace(/^\./, "").toLowerCase() : "";
  const inferred = site.protocol !== "https:" || !(domain === site.hostname || domain.endsWith("." + site.hostname));
  return { topLevelSite: site.origin, hasCrossSiteAncestor: bit == null ? inferred : bit };
}

module.exports = { normalizeCookiePartition, PARTITION_COOKIE_ERROR };
