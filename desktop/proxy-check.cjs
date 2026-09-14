const { session, net } = require("electron");

/**
 * Проверяет прокси прямо в приложении: поднимает временную сессию с этим
 * прокси и спрашивает у ip-api.com, какой IP и страна видны снаружи.
 * Работает и для SOCKS5, чего веб-версия сделать не может.
 */
async function checkProxy({ id, protocol, host, port, username, password }) {
  const scheme = protocol === "socks5" ? "socks5" : protocol === "https" ? "https" : "http";
  const ses = session.fromPartition(`proxy-check-${id || host}-${Date.now()}`);
  await ses.setProxy({ proxyRules: `${scheme}://${host}:${port}`, proxyBypassRules: "<local>" });

  const started = Date.now();

  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve({ ...r, latency: Date.now() - started });
    };

    let request;
    try {
      request = net.request({
        method: "GET",
        url: "http://ip-api.com/json/?fields=status,countryCode,city,query",
        session: ses,
        useSessionCookies: false,
      });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* уже завершён */
      }
      finish({ ok: false, error: "Прокси не ответил за 15 секунд" });
    }, 15000);

    request.on("login", (_authInfo, callback) => {
      callback(username || "", password || "");
    });

    request.on("response", (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk.toString();
      });
      response.on("end", () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(body);
          if (json.status === "success") {
            finish({ ok: true, ip: json.query, country: json.countryCode, city: json.city });
          } else {
            finish({ ok: false, error: "Прокси ответил, но IP определить не удалось" });
          }
        } catch {
          finish({ ok: false, error: "Неожиданный ответ через прокси" });
        }
      });
    });

    request.on("error", (err) => {
      clearTimeout(timer);
      const msg = err && err.message ? err.message : String(err);
      finish({
        ok: false,
        error: /TUNNEL|PROXY|SOCKS/i.test(msg) ? "Прокси не принимает соединение" : msg,
      });
    });

    request.end();
  });
}

module.exports = { checkProxy };
