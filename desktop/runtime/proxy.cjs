const { proxyConfig } = require("./validation.cjs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

function blockSession(ses) {
  ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
}

async function createRuntimeProxy(ses, proxy, { WorkerClass = Worker } = {}) {
  blockSession(ses);
  let worker;
  let disposed = false;
  let workerFailed = false;
  const diagnostics = { mode: "blocked", authenticated: false, requests: 0, failures: 0 };
  try {
    await ses.closeAllConnections();
    if (proxy === null) {
      // Direct mode must be explicit; configured proxy failures never reach it.
      await ses.setProxy({ mode: "direct" });
      diagnostics.mode = "direct";
    } else {
      const upstream = proxyConfig(proxy);
      diagnostics.mode = upstream.protocol;
      diagnostics.authenticated = upstream.authenticated;
      worker = new WorkerClass(path.join(__dirname, "proxy-worker.cjs"), { workerData: { upstreamProxyUrl: upstream.url }, stdout: true, stderr: true });
      // Drain without logging: third-party diagnostics can contain credentials.
      worker.stdout?.resume();
      worker.stderr?.resume();
      const failed = () => {
        workerFailed = true;
        diagnostics.failures++;
        blockSession(ses);
        void ses.closeAllConnections().catch(() => {});
      };
      worker.on("error", failed);
      worker.on("exit", () => { if (!disposed) failed(); });
      worker.on("message", (message) => {
        if (message.type === "stats") { diagnostics.requests = message.requests; diagnostics.failures = Math.max(diagnostics.failures, message.failures); }
        if (message.type === "failed") failed();
      });
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Proxy startup timed out")), 5000);
        const onFailure = () => finish(new Error("Proxy startup failed"));
        const onMessage = (message) => {
          if (message.type === "ready") finish(null, message.port);
          if (message.type === "failed") onFailure();
        };
        function finish(error, value) {
          clearTimeout(timer);
          worker.removeListener("error", onFailure);
          worker.removeListener("exit", onFailure);
          worker.removeListener("message", onMessage);
          if (error) reject(error); else resolve(value);
        }
        worker.on("message", onMessage);
        worker.once("error", onFailure);
        worker.once("exit", onFailure);
      });
      await ses.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: "<-loopback>" });
    }
    await ses.closeAllConnections();
    if (workerFailed) throw new Error("Proxy worker stopped during setup");
    ses.webRequest.onBeforeRequest(null);
    return {
      diagnostics,
      async dispose() {
        if (disposed) return;
        disposed = true;
        blockSession(ses);
        try { await ses.closeAllConnections(); }
        finally { if (worker) await worker.terminate(); }
      },
    };
  } catch {
    blockSession(ses);
    if (worker) { disposed = true; await worker.terminate().catch(() => {}); }
    throw new Error("Proxy setup failed; traffic is blocked");
  }
}

module.exports = { createRuntimeProxy, blockSession };
