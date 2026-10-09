// Shared, locale-independent identity of the fields actually synchronized.
// Callers validate the cookies first. Never use timestamps as content identity.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function synchronizedCookies(cookies) {
  const entries = cookies.map(cookie => {
    const session = cookie.session === true || cookie.expirationDate == null;
    return JSON.stringify(stable({ name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path || "/", hostOnly: cookie.hostOnly ?? !cookie.domain.startsWith("."),
      secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
      session, sameSite: cookie.sameSite || "unspecified",
      ...(!session ? { expirationDate: cookie.expirationDate } : {}),
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    }));
  }).sort();
  return `[${entries.join(",")}]`;
}
module.exports = { synchronizedCookies };
