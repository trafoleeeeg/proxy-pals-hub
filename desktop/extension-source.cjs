const https = require("node:https");

const MAX_BYTES = 200 * 1024 * 1024;
const STORE_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

function chromeVersion() {
  const version = String(process.versions.chrome || "120.0.0.0");
  return /^\d+(\.\d+)*$/.test(version) ? version : "120.0.0.0";
}

// Turns a pasted link into the address the file is actually downloaded from.
function parseExtensionUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("Ссылка указана неверно"); }
  if (url.protocol !== "https:") throw new Error("Поддерживаются только ссылки https");
  if (url.username || url.password) throw new Error("Ссылка указана неверно");
  const storeId = STORE_HOSTS.includes(url.hostname)
    ? (url.pathname.match(/\/([a-p]{32})(?:\/|$)/) || [])[1]
    : undefined;
  if (storeId) {
    const download = "https://clients2.google.com/service/update2/crx?response=redirect"
      + "&acceptformat=crx2,crx3&prodversion=" + chromeVersion()
      + "&x=" + encodeURIComponent("id=" + storeId + "&installsource=ondemand&uc");
    return { kind: "store", key: "store:" + storeId, storeId, pageUrl: url.toString(), downloadUrl: download };
  }
  if (STORE_HOSTS.includes(url.hostname)) throw new Error("В ссылке магазина не найден идентификатор расширения");
  return { kind: "url", key: "url:" + url.toString(), pageUrl: url.toString(), downloadUrl: url.toString() };
}

function fetchBuffer(target, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Слишком много перенаправлений при загрузке"));
    let url;
    try { url = new URL(target); } catch { return reject(new Error("Ссылка указана неверно")); }
    if (url.protocol !== "https:") return reject(new Error("Поддерживаются только ссылки https"));
    const request = https.get(url, { timeout: 60_000, headers: { "user-agent": "Umbra", accept: "*/*" } }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        return resolve(fetchBuffer(new URL(location, url).toString(), redirects + 1));
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error("Источник вернул ошибку " + status + ". Проверьте ссылку."));
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { request.destroy(); reject(new Error("Файл расширения слишком большой")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", () => reject(new Error("Загрузка расширения прервалась")));
    });
    request.on("timeout", () => { request.destroy(); reject(new Error("Источник не ответил вовремя")); });
    request.on("error", () => reject(new Error("Не удалось скачать расширение по ссылке")));
  });
}

module.exports = { parseExtensionUrl, fetchBuffer, chromeVersion };
