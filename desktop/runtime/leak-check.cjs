const { randomUUID } = require("node:crypto");
const { isIP } = require("node:net");
const { requestJson } = require("./proxy-probe.cjs");
const { blockSession } = require("./proxy.cjs");

const IP_ENDPOINT = "https://api.ipify.org?format=json";
const DNS_ENDPOINT = "https://edns.ip-api.com/json";
const SAFE_WEBRTC = "disable_non_proxied_udp";

function pickIp(json) {
  if (!json) return "";
  if (typeof json.ip === "string" && isIP(json.ip)) return json.ip;
  const dns = json.dns;
  if (dns && typeof dns.ip === "string" && isIP(dns.ip)) return dns.ip;
  return "";
}

// Проверка утечек: сравниваем внешний адрес профиля и адрес DNS-резолвера
// с реальным адресом компьютера. Совпадение означает, что трафик идёт мимо прокси.
function createLeakAudit({ session, net }, options = {}) {
  const fetchJson = options.requestJson || requestJson;
  const block = options.blockSession || blockSession;
  const timeoutMs = options.timeoutMs || 15000;
  const ipEndpoint = options.ipEndpoint || IP_ENDPOINT;
  const dnsEndpoint = options.dnsEndpoint || DNS_ENDPOINT;

  async function directIp() {
    const ses = session.fromPartition(`leak-check-${randomUUID()}`, { cache: false });
    try {
      await ses.setProxy({ mode: "direct" });
      return pickIp(await fetchJson(net, ses, ipEndpoint, timeoutMs));
    } finally {
      await Promise.allSettled([ses.closeAllConnections(), ses.clearStorageData(), ses.clearCache()]);
    }
  }

  return async function auditLeaks({ ses, hasProxy, webrtcPolicy }) {
    const checks = [];
    let leaked = false;
    const add = (id, label, state, detail) => {
      checks.push({ id, label, state, detail: detail || "" });
      if (state === "leak") leaked = true;
    };

    const policy = webrtcPolicy || (ses?.getWebRTCIPHandlingPolicy?.() ?? "");
    if (policy === SAFE_WEBRTC || !hasProxy) add("webrtc", "WebRTC", hasProxy ? "ok" : "skip", hasProxy ? "Локальные адреса скрыты" : "Прокси не используется");
    else add("webrtc", "WebRTC", "leak", "WebRTC может раскрыть реальный адрес");

    if (!hasProxy) {
      add("ip", "Внешний IP", "skip", "Прокси не используется");
      add("dns", "DNS", "skip", "Прокси не используется");
      return { ok: !leaked, leaked, checks, ip: "", directIp: "" };
    }

    let real = "";
    try { real = await directIp(); } catch { real = ""; }

    let profileIp = "";
    try { profileIp = pickIp(await fetchJson(net, ses, ipEndpoint, timeoutMs)); } catch { profileIp = ""; }
    if (!profileIp) add("ip", "Внешний IP", "error", "Не удалось определить адрес профиля");
    else if (real && profileIp === real) add("ip", "Внешний IP", "leak", `Виден реальный адрес ${profileIp}`);
    else add("ip", "Внешний IP", "ok", profileIp);

    let dnsIp = "";
    try { dnsIp = pickIp(await fetchJson(net, ses, dnsEndpoint, timeoutMs)); } catch { dnsIp = ""; }
    if (!dnsIp) add("dns", "DNS", "error", "Не удалось проверить DNS-сервер");
    else if (real && dnsIp === real) add("dns", "DNS", "leak", `DNS-запросы идут мимо прокси (${dnsIp})`);
    else add("dns", "DNS", "ok", dnsIp);

    if (leaked && ses) { try { block(ses); await ses.closeAllConnections?.(); } catch { /* сессия уже закрыта */ } }
    return { ok: !leaked, leaked, checks, ip: profileIp, directIp: real };
  };
}

module.exports = { createLeakAudit, SAFE_WEBRTC, IP_ENDPOINT, DNS_ENDPOINT };
