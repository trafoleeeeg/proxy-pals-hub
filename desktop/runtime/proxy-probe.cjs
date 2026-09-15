const { randomUUID } = require("node:crypto");
const { isIP } = require("node:net");
const { createRuntimeProxy } = require("./proxy.cjs");
const ENDPOINTS = ["https://api.ipify.org?format=json", "https://api64.ipify.org?format=json"];

function requestJson(net, ses, url, timeoutMs, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let request;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Proxy check timed out")), timeoutMs);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (request) { try { request.abort(); } catch { /* Already completed. */ } }
      if (error) reject(error); else resolve(value);
    }
    try {
      if (new URL(url).protocol !== "https:") throw new Error("HTTPS endpoint required");
      request = net.request({ method: "GET", url, session: ses, useSessionCookies: false, redirect: "error" });
      request.on("error", () => finish(new Error("Proxy connection failed")));
      request.on("abort", () => finish(new Error("Proxy check aborted")));
      request.on("login", (_authInfo, callback) => { callback(); finish(new Error("Unexpected authentication challenge")); });
      request.on("redirect", () => finish(new Error("Proxy endpoint redirected")));
      request.on("response", (response) => {
        if (response.statusCode !== 200) return finish(new Error("Proxy endpoint rejected the request"));
        let size = 0;
        const chunks = [];
        response.on("error", () => finish(new Error("Proxy response interrupted")));
        response.on("aborted", () => finish(new Error("Proxy response interrupted")));
        response.on("data", (chunk) => {
          if (finished) return;
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > maxBytes) return finish(new Error("Proxy response exceeds size limit"));
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (finished) return;
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { finish(new Error("Invalid proxy endpoint response")); }
        });
      });
      request.end();
    } catch { finish(new Error("Unable to start proxy check")); }
  });
}

function createProxyChecker({ session, net }, { setupProxy = createRuntimeProxy, endpoints = ENDPOINTS, timeoutMs = 15000 } = {}) {
  return async function checkProxy(proxy) {
    const started = Date.now();
    const ses = session.fromPartition(`proxy-check-${randomUUID()}`, { cache: false });
    let runtime;
    let result;
    try {
      if (!proxy) throw new Error("Proxy configuration is required");
      runtime = await setupProxy(ses, proxy);
      let lastError;
      for (let index = 0; index < endpoints.length; index++) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) throw new Error("Proxy check timed out");
        try {
          const json = await requestJson(net, ses, endpoints[index], Math.max(1, Math.floor(remaining / (endpoints.length - index))));
          if (!json || !isIP(json.ip)) throw new Error("Proxy endpoint returned no valid IP");
          result = { ok: true, ip: json.ip };
          break;
        } catch (error) { lastError = error; }
      }
      if (!result) throw lastError || new Error("Proxy check failed");
    } catch (error) {
      result = { ok: false, error: error.message };
    } finally {
      const cleanup = await Promise.allSettled([runtime ? runtime.dispose() : ses.closeAllConnections(), ses.clearStorageData(), ses.clearCache()]);
      if (cleanup.some((item) => item.status === "rejected")) result = { ok: false, error: "Proxy check cleanup failed" };
    }
    return { ...result, latency: Date.now() - started };
  };
}

module.exports = { createProxyChecker, requestJson };
