const { isIP } = require("node:net");
const { requestJson } = require("./proxy-probe.cjs");
const { blockSession } = require("./proxy.cjs");
const IP_ENDPOINT = "https://api.ipify.org?format=json";
const SAFE_WEBRTC = "disable_non_proxied_udp";

// Connection diagnostics are not proof of leak absence. Never contact a
// service through a direct session just to discover the host's real IP.
function createLeakAudit({ net }, options = {}) {
  const fetchJson = options.requestJson || requestJson;
  const block = options.blockSession || blockSession;
  return async function auditLeaks({ ses, hasProxy, webrtcPolicy }) {
    if (!hasProxy) return { ok: false, complete: false, leaked: false, ip: "", checks: [
      { id: "ip", label: "Внешний IP", state: "skip", detail: "Прямое подключение: сайт видит адрес вашей сети" },
      { id: "dns", label: "DNS", state: "skip", detail: "Прокси не используется" },
      { id: "webrtc", label: "WebRTC", state: "skip", detail: "Прокси не используется" },
    ] };
    const policy = webrtcPolicy || ses?.getWebRTCIPHandlingPolicy?.() || "";
    const leaked = policy !== SAFE_WEBRTC;
    const checks = [{ id: "webrtc", label: "WebRTC", state: leaked ? "leak" : "unknown",
      detail: leaked ? "Защитная политика не подтверждена — трафик заблокирован" : "Запрет непроксируемого UDP установлен; ICE-кандидаты не проверялись" }];
    if (leaked && ses) {
      block(ses);
      await ses.closeAllConnections?.().catch(() => {});
    }
    let ip = "";
    if (!leaked) {
      try {
        const json = await fetchJson(net, ses, options.ipEndpoint || IP_ENDPOINT, options.timeoutMs || 15000);
        if (typeof json?.ip === "string" && isIP(json.ip)) ip = json.ip;
      } catch { /* Unknown is not a successful test. */ }
    }
    checks.push({ id: "ip", label: "Внешний IP", state: ip ? "unknown" : "error",
      detail: ip ? ip + " · адрес получен через сессию профиля; отсутствие обходных маршрутов не доказано" : "Не удалось определить адрес профиля" });
    checks.push({ id: "dns", label: "DNS", state: "unknown", detail: "Нужен отдельный DNS challenge-тест; адрес резолвера сам по себе не доказывает отсутствие утечки" });
    return { ok: false, complete: false, leaked, checks, ip };
  };
}

module.exports = { createLeakAudit, SAFE_WEBRTC, IP_ENDPOINT };
