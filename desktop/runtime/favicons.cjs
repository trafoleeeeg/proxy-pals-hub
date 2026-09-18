const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 6000;
const TYPES = /^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)/i;

// Значки закладок загружаются внутри сессии профиля, то есть через его прокси.
// Ответ принимается только если это настоящая картинка разумного размера.
function requestIcon(net, ses, url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let request;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Значок не загрузился")), timeoutMs);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (request) { try { request.abort(); } catch { /* запрос уже завершён */ } }
      if (error) reject(error); else resolve(value);
    }
    try {
      if (new URL(url).protocol !== "https:") throw new Error("Нужен HTTPS-адрес");
      request = net.request({ method: "GET", url, session: ses, useSessionCookies: false });
      request.on("error", () => finish(new Error("Значок недоступен")));
      request.on("abort", () => finish(new Error("Загрузка значка прервана")));
      request.on("login", (_info, callback) => { callback(); finish(new Error("Неожиданный запрос пароля")); });
      request.on("response", (response) => {
        if (response.statusCode !== 200) return finish(new Error("Значок не найден"));
        const type = String(response.headers["content-type"] || response.headers["Content-Type"] || "");
        const mime = Array.isArray(type) ? type[0] : type;
        let size = 0;
        const chunks = [];
        response.on("error", () => finish(new Error("Загрузка значка прервана")));
        response.on("aborted", () => finish(new Error("Загрузка значка прервана")));
        response.on("data", (chunk) => {
          if (finished) return;
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_BYTES) return finish(new Error("Значок слишком большой"));
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (finished) return;
          const clean = String(mime).split(";")[0].trim();
          if (!TYPES.test(clean) || !chunks.length) return finish(new Error("Это не картинка"));
          finish(null, `data:${clean};base64,${Buffer.concat(chunks).toString("base64")}`);
        });
      });
      request.end();
    } catch { finish(new Error("Не удалось запросить значок")); }
  });
}

function iconSources(pageUrl) {
  let host;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    host = parsed.hostname;
  } catch { return []; }
  if (!host) return [];
  return [`https://${host}/favicon.ico`, `https://icons.duckduckgo.com/ip3/${host}.ico`];
}

function createFaviconLoader({ net }, { fetchIcon = requestIcon, limit = 4 } = {}) {
  const cache = new Map();
  const failed = new Set();
  return {
    get: (url) => cache.get(url) || "",
    // Догружает значки только для тех закладок, у которых их ещё нет.
    async load(ses, urls, onUpdate = () => {}) {
      const pending = [...new Set(urls)].filter((url) => url && !cache.has(url) && !failed.has(url)).slice(0, 64);
      for (let index = 0; index < pending.length; index += limit) {
        const batch = pending.slice(index, index + limit);
        await Promise.all(batch.map(async (url) => {
          for (const source of iconSources(url)) {
            try {
              const icon = await fetchIcon(net, ses, source);
              if (icon) { cache.set(url, icon); return; }
            } catch { /* пробуем следующий источник */ }
          }
          failed.add(url);
        }));
        onUpdate();
      }
      return cache;
    },
  };
}

module.exports = { createFaviconLoader, requestIcon, iconSources, MAX_BYTES };
