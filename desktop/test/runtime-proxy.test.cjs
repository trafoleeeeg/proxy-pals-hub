const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRuntimeProxy } = require("../runtime/proxy.cjs");
const { requestJson, createProxyChecker } = require("../runtime/proxy-probe.cjs");
const { testCertificate, listen, mockSocks, mockElectronSession, nodeNet } = require("./runtime-proxy-fixtures.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-proxy-test-"));
  const certificate = testCertificate(directory);
  let hits = 0;
  const origin = https.createServer(certificate, (req, res) => {
    hits++;
    if (req.url === "/slow") return;
    if (req.url === "/large") return res.end("x".repeat(100000));
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://localhost/unsafe" }); return res.end(); }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ip: "203.0.113.7" }));
  });
  const listening = await listen(origin);
  t.after(async () => { await listening.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { ...listening, certificate, net: nodeNet(certificate.cert), get hits() { return hits; } };
}

test("authenticated HTTP upstream reaches HTTPS origin; wrong credentials never reach origin", async (t) => {
  const f = await fixture(t);
  const { Server } = await import("proxy-chain");
  let rejected = 0;
  const upstream = new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: ({ username, password }) => { const bad = username !== "fixture-user" || password !== "fixture-pass"; if (bad) rejected++; return { requestAuthentication: bad }; } });
  await upstream.listen(); t.after(() => upstream.close(true));
  for (const [password, expected] of [["fixture-pass", true], ["wrong", false]]) {
    const ses = mockElectronSession();
    const runtime = await createRuntimeProxy(ses, { protocol: "http", host: "127.0.0.1", port: upstream.port, username: "fixture-user", password });
    try {
      assert.equal(ses.config.proxyBypassRules, "<-loopback>");
      const probe = requestJson(f.net, ses, `https://localhost:${f.port}/`, 3000);
      if (expected) assert.equal((await probe).ip, "203.0.113.7"); else await assert.rejects(probe, /connection/);
    } finally { await runtime.dispose(); }
    assert.equal(typeof ses.webRequest.handler, "function");
  }
  assert.equal(f.hits, 1); assert.equal(rejected, 1);
});

test("SOCKS5 username/password, remote DNS, wrong credentials and concurrent auth isolation", async (t) => {
  const f = await fixture(t);
  const upstream = await mockSocks(f.port);
  t.after(() => upstream.close());
  const results = await Promise.all(["fixture-pass", "wrong"].map(async (password) => {
    const ses = mockElectronSession();
    const runtime = await createRuntimeProxy(ses, { protocol: "socks5", host: "127.0.0.1", port: upstream.port, username: "fixture-user", password });
    try {
      return await requestJson(f.net, ses, `https://fixture.test:${f.port}/`, 3000).then(() => true, () => false);
    } finally { await runtime.dispose(); }
  }));
  assert.deepEqual(results, [true, false]);
  assert.equal(f.hits, 1);
  assert.equal(upstream.observations.accepted, 1); assert.equal(upstream.observations.rejected, 1);
  assert.equal(upstream.observations.destinations[0].host, "fixture.test");
});

test("checker bounds response size/time, rejects redirects and frees stalled SOCKS negotiation", async (t) => {
  const f = await fixture(t);
  const upstream = await mockSocks(f.port);
  t.after(() => upstream.close());
  const payload = { protocol: "socks5", host: "127.0.0.1", port: upstream.port, username: "fixture-user", password: "fixture-pass" };
  for (const pathname of ["/large", "/slow", "/redirect"]) {
    const sessions = [];
    const checker = createProxyChecker({ net: f.net, session: { fromPartition() { const ses = mockElectronSession(); sessions.push(ses); return ses; } } }, { endpoints: [`https://fixture.test:${f.port}${pathname}`], timeoutMs: 750 });
    const result = await checker(payload);
    assert.equal(result.ok, false); assert.ok(result.latency < 2500);
    assert.equal(sessions[0].cleared, true); assert.equal(typeof sessions[0].webRequest.handler, "function");
  }
  const stalled = await mockSocks(f.port, { stall: true }); t.after(() => stalled.close());
  const checker = createProxyChecker({ net: f.net, session: { fromPartition: mockElectronSession } }, { endpoints: [`https://fixture.test:${f.port}/`], timeoutMs: 750 });
  const result = await checker({ ...payload, port: stalled.port });
  assert.equal(result.ok, false); assert.ok(result.latency < 2500);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stalled.sockets.size, 0, "pending upstream handshake must be cancelled");
});

test("untrusted HTTPS upstream certificate is rejected with no direct fallback", async (t) => {
  const f = await fixture(t);
  const { Server } = await import("proxy-chain");
  const upstream = new Server({ host: "127.0.0.1", port: 0, serverType: "https", httpsOptions: f.certificate });
  await upstream.listen(); t.after(() => upstream.close(true));
  const ses = mockElectronSession(); const runtime = await createRuntimeProxy(ses, { protocol: "https", host: "localhost", port: upstream.port });
  try { await assert.rejects(requestJson(f.net, ses, `https://localhost:${f.port}/`, 3000)); }
  finally { await runtime.dispose(); }
  assert.equal(f.hits, 0);
});

test("missing/invalid configured proxy remains blocked and never selects direct mode", async () => {
  for (const proxy of [undefined, {}, { protocol: "invalid", host: "localhost", port: 80 }]) {
    const ses = mockElectronSession();
    await assert.rejects(createRuntimeProxy(ses, proxy), /traffic is blocked/);
    assert.equal(ses.config, null); assert.equal(typeof ses.webRequest.handler, "function");
  }
});
