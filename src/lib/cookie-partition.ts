export type CookiePartitionKey = { topLevelSite: string; hasCrossSiteAncestor: boolean };
export const PARTITION_COOKIE_ERROR = "Некорректный ключ CHIPS cookie. Нужен topLevelSite HTTP(S); непрозрачные ключи перенести нельзя.";

/** Chrome extension exports before 130 may omit the ancestor bit. Apply the
 * extension API's default: cross-site iff the cookie URL is outside the
 * serialized top-level schemeful site; never create copies in both partitions. */
export function normalizeCookiePartition(cookie: Record<string, unknown>): CookiePartitionKey | undefined {
  for (const flag of ["partitioned", "partitionKeyOpaque"]) if (cookie[flag] != null && typeof cookie[flag] !== "boolean") throw new Error(PARTITION_COOKIE_ERROR);
  if (cookie["partitionKeyOpaque"] === true) throw new Error(PARTITION_COOKIE_ERROR);
  const key = cookie["partitionKey"];
  if (key == null) {
    if (cookie["partitioned"] === true) throw new Error(PARTITION_COOKIE_ERROR);
    return undefined;
  }
  if (typeof key !== "object" || Array.isArray(key)) throw new Error(PARTITION_COOKIE_ERROR);
  const partition = key as Record<string, unknown>;
  if (Object.keys(partition).some(field => !["topLevelSite", "hasCrossSiteAncestor"].includes(field))
    || typeof partition["topLevelSite"] !== "string" || /[\x00-\x20\x7f]/.test(partition["topLevelSite"]) || cookie["secure"] !== true) throw new Error(PARTITION_COOKIE_ERROR);
  let site: URL;
  try { site = new URL(partition["topLevelSite"]); } catch { throw new Error(PARTITION_COOKIE_ERROR); }
  if (!["http:", "https:"].includes(site.protocol) || !site.hostname || site.username || site.password
    || site.port || site.pathname !== "/" || site.search || site.hash) throw new Error(PARTITION_COOKIE_ERROR);
  const bit = partition["hasCrossSiteAncestor"];
  if (bit !== undefined && typeof bit !== "boolean") throw new Error(PARTITION_COOKIE_ERROR);
  const domain = typeof cookie["domain"] === "string" ? cookie["domain"].replace(/^\./, "").toLowerCase() : "";
  const inferred = site.protocol !== "https:" || !(domain === site.hostname || domain.endsWith("." + site.hostname));
  return { topLevelSite: site.origin, hasCrossSiteAncestor: bit == null ? inferred : bit as boolean };
}
