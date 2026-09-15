// Local-only proxy fixtures shared by Node and native Electron tests.
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");

function testCertificate(directory) {
  const candidates = process.platform === "win32" ? ["C:/Program Files/Git/usr/bin/openssl.exe", "C:/Program Files/Git/mingw64/bin/openssl.exe"] : ["openssl"];
  const executable = candidates.find((value) => value === "openssl" || fs.existsSync(value));
  if (!executable) throw new Error("Test TLS fixture requires OpenSSL");
  const keyFile = path.join(directory, "localhost-key.pem");
  const certFile = path.join(directory, "localhost-cert.pem");
  const result = spawnSync(executable, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:fixture.test,IP:127.0.0.1"], { windowsHide: true, stdio: "ignore" });
  if (result.status !== 0) throw new Error("Unable to generate local test TLS certificate");
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), certFile };
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  return { port: server.address().port, sockets, async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}

async function mockSocks(targetPort, { username = "fixture-user", password = "fixture-pass", stall = false } = {}) {
  const observations = { accepted: 0, rejected: 0, destinations: [] };
  const outgoing = new Set();
  const server = net.createServer((socket) => {
    if (stall) { socket.resume(); return; }
    let state = "greeting";
    let buffer = Buffer.alloc(0);
    const onData = (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (state === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        const valid = buffer[0] === 5 && buffer.subarray(2, 2 + buffer[1]).includes(2);
        buffer = buffer.subarray(2 + buffer[1]);
        if (!valid) return socket.end(Buffer.from([5, 255]));
        socket.write(Buffer.from([5, 2])); state = "auth";
      }
      if (state === "auth") {
        if (buffer.length < 2 || buffer.length < buffer[1] + 3) return;
        const userLength = buffer[1];
        const passLength = buffer[2 + userLength];
        if (buffer.length < 3 + userLength + passLength) return;
        const valid = buffer[0] === 1 && buffer.subarray(2, 2 + userLength).toString() === username && buffer.subarray(3 + userLength, 3 + userLength + passLength).toString() === password;
        buffer = buffer.subarray(3 + userLength + passLength);
        if (!valid) { observations.rejected++; return socket.end(Buffer.from([1, 1])); }
        observations.accepted++; socket.write(Buffer.from([1, 0])); state = "connect";
      }
      if (state === "connect") {
        if (buffer.length < 5) return;
        const addressLength = buffer[3] === 3 ? 1 + buffer[4] : buffer[3] === 1 ? 4 : 16;
        if (buffer.length < 6 + addressLength) return;
        const host = buffer[3] === 3 ? buffer.subarray(5, 4 + addressLength).toString() : buffer.subarray(4, 4 + addressLength).join(".");
        const port = buffer.readUInt16BE(4 + addressLength);
        observations.destinations.push({ host, port });
        if (port !== targetPort) return socket.end(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 0]));
        socket.removeListener("data", onData);
        const upstream = net.connect(targetPort, "127.0.0.1");
        outgoing.add(upstream); upstream.on("close", () => outgoing.delete(upstream));
        upstream.on("connect", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          const remainder = buffer.subarray(6 + addressLength);
          if (remainder.length) upstream.write(remainder);
          socket.pipe(upstream); upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        socket.on("close", () => upstream.destroy());
      }
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  const listener = await listen(server);
  return { ...listener, observations, async close() { for (const socket of outgoing) socket.destroy(); await listener.close(); } };
}

function mockElectronSession() {
  return {
    config: null, blocked: false, cleared: false,
    webRequest: { onBeforeRequest(handler) { this.handler = handler; } },
    async setProxy(config) { this.config = config; },
    async closeAllConnections() {},
    async clearStorageData() { this.cleared = true; },
    async clearCache() {},
  };
}

// A Node HTTP/TLS client adapter exercises real proxy-chain sockets in node:test.
// The native Electron test separately verifies Chromium's session proxy behavior.
function nodeNet(ca) {
  return {
    request(options) {
      const emitter = new EventEmitter();
      const sockets = [];
      let agent;
      let aborted = false;
      emitter.abort = () => { aborted = true; for (const socket of sockets) socket.destroy(); agent?.destroy(); };
      emitter.end = () => {
        const url = new URL(options.url);
        const bridge = new URL(options.session.config.proxyRules);
        const connect = http.request({ hostname: bridge.hostname, port: bridge.port, method: "CONNECT", path: `${url.hostname}:${url.port || 443}`, agent: false });
        sockets.push(connect);
        connect.on("error", (error) => { if (!aborted) emitter.emit("error", error); });
        connect.on("connect", (response, socket, head) => {
          sockets.push(socket);
          if (response.statusCode !== 200) { socket.destroy(); emitter.emit("error", new Error("CONNECT rejected")); return; }
          if (head.length) socket.unshift(head);
          const secure = tls.connect({ socket, servername: url.hostname, ca });
          sockets.push(secure);
          secure.on("error", (error) => { if (!aborted) emitter.emit("error", error); });
          secure.once("secureConnect", () => {
            agent = new https.Agent({ keepAlive: false }); agent.createConnection = () => secure;
            const request = https.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, agent }, (res) => emitter.emit("response", res));
            sockets.push(request);
            request.on("error", (error) => { if (!aborted) emitter.emit("error", error); });
            request.end();
          });
        });
        connect.end();
      };
      return emitter;
    },
  };
}

module.exports = { testCertificate, listen, mockSocks, mockElectronSession, nodeNet };
