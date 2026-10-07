const { normalizeCookiePartition } = require("./cookie-partition.cjs");

function protocolCookie(cookie) {
  const host = cookie.domain.replace(/^\./, "");
  const result = { name: cookie.name, value: cookie.value, url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    path: cookie.path || "/", secure: cookie.secure === true, httpOnly: cookie.httpOnly === true };
  if (!cookie.hostOnly) result.domain = cookie.domain;
  if (!cookie.session && cookie.expirationDate != null) result.expires = cookie.expirationDate;
  const sites = { no_restriction: "None", lax: "Lax", strict: "Strict" };
  if (sites[cookie.sameSite]) result.sameSite = sites[cookie.sameSite];
  const key = normalizeCookiePartition(cookie);
  if (key) result.partitionKey = key;
  return result;
}

function exportedCookie(cookie) {
  const result = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    hostOnly: !cookie.domain.startsWith("."), secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
    session: cookie.session === true, sameSite: ({ None: "no_restriction", Lax: "lax", Strict: "strict" })[cookie.sameSite] || "unspecified" };
  if (!result.session && cookie.expires >= 0) result.expirationDate = cookie.expires;
  if (cookie.partitionKeyOpaque === true) throw new Error("Непрозрачный ключ CHIPS нельзя сохранить для переноса; исходные данные не изменены");
  const key = normalizeCookiePartition(cookie);
  if (key) result.partitionKey = key;
  return result;
}

function createCookieTransport(protocol, { timeoutMs = 10000 } = {}) {
  let unavailable = false;
  const failure = () => Object.assign(new Error("Cookie partition transport unavailable"), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
  const command = async (task, reading = false) => {
    if (unavailable) throw failure();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(task),
        new Promise((_, reject) => { timer = setTimeout(() => { if (!reading) unavailable = true; reject(failure()); }, timeoutMs); }),
      ]);
    } catch (error) {
      if (reading || error?.code === "COOKIE_TRANSPORT_UNAVAILABLE") throw failure();
      // CDP errors may include cookie contents. Never forward them to UI/logs.
      throw new Error("Cookie rejected by Chromium");
    } finally { clearTimeout(timer); }
  };
  return {
    async read() {
      const result = await command(() => protocol.read(), true);
      if (!Array.isArray(result?.cookies)) throw failure();
      return result.cookies.map(exportedCookie);
    },
    async write(cookie) { const details = protocolCookie(cookie); await command(() => protocol.write([details])); },
    dispose() { unavailable = true; protocol.dispose?.(); },
  };
}

module.exports = { createCookieTransport, protocolCookie, exportedCookie };
