const { parentPort, workerData } = require("node:worker_threads");

// Owning every upstream socket in one worker makes even a stalled SOCKS handshake
// cancellable. proxy-chain does not expose cancellation for pending SOCKS clients.
(async () => {
  const { Server } = await import("proxy-chain");
  let requests = 0;
  let failures = 0;
  const report = () => parentPort.postMessage({ type: "stats", requests, failures });
  const server = new Server({
    host: "127.0.0.1", port: 0, verbose: false,
    prepareRequestFunction: () => {
      requests++;
      report();
      return { upstreamProxyUrl: workerData.upstreamProxyUrl, ignoreUpstreamProxyCertificate: false };
    },
  });
  server.on("requestFailed", () => { failures++; report(); });
  server.on("tunnelConnectFailed", () => { failures++; report(); });
  server.on("error", () => parentPort.postMessage({ type: "failed" }));
  await server.listen();
  parentPort.postMessage({ type: "ready", port: server.port });
})().catch(() => parentPort.postMessage({ type: "failed" }));
