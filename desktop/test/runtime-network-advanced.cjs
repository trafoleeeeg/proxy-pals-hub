const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const dgram = require("node:dgram");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createRuntimeProxy } = require("../runtime/proxy.cjs");
const { normalizeFingerprint, applyFingerprint } = require("../runtime/fingerprint.cjs");
const { listen, mockSocks } = require("./runtime-proxy-fixtures.cjs");

function resolverActivity(log, names) {
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const active = new Map();
  const result = { requests: 0, tasks: [], network: [] };
  const matches = value => typeof value === "string" && names.some(name => {
    try { return new URL(value.includes("://") ? value : `http://${value}`).hostname === name; } catch { return value === name; }
  });
  for (const event of log.events) {
    const type = types[event.type] || "";
    const key = `${event.source.type}:${event.source.id}`;
    if (type === "HOST_RESOLVER_MANAGER_REQUEST" && event.phase === 1) {
      const selected = matches(event.params?.host);
      active.set(key, selected); if (selected) result.requests++;
    }
    if (active.get(key)) {
      if (type === "HOST_RESOLVER_MANAGER_TASK_SEQUENCE_CREATED") {
        for (const task of event.params?.tasks || []) {
          result.tasks.push(task);
          // Persisted Chromium TaskType IDs: only caches, config, hosts are local.
          if (![4, 5, 6, 7, 9].includes(task)) result.network.push(`task:${task}`);
        }
      }
      if (/HOST_RESOLVER_.*(?:JOB|DNS_TASK|SYSTEM_TASK)|DNS_TRANSACTION/.test(type)) result.network.push(type);
    }
    if (/DNS_TRANSACTION|HOST_RESOLVER.*JOB/.test(type) && [event.params?.hostname, event.params?.host].some(matches)) result.network.push(type);
    if (type === "HOST_RESOLVER_MANAGER_REQUEST" && event.phase === 2) active.delete(key);
  }
  return result;
}

async function iceProbe(url) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: url, username: "fixture", credential: "fixture-password" }], iceTransportPolicy: "relay" });
  try {
    pc.createDataChannel("probe");
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const types = [];
    pc.onicecandidate = e => { if (e.candidate) types.push(e.candidate.type); };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") finish(true); };
    const timer = setTimeout(() => finish(false), 1800);
    try { await pc.setLocalDescription(await pc.createOffer()); return { complete: await done, types }; }
    finally { clearTimeout(timer); }
  } finally { pc.close(); }
}

async function auditAdvancedNetwork({ electron, plainPort, proxy, cleanups, allowedPorts, proxyDestinations, directory, certificate }) {
  const { session, BrowserWindow } = electron;
  async function open(protectedProfile, configuredProxy = protectedProfile ? proxy : null) {
    const ses = session.fromPartition(`advanced-${randomUUID()}`);
    const bridge = await createRuntimeProxy(ses, configuredProxy); cleanups.push(() => bridge.dispose());
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    cleanups.push(async () => { if (!win.isDestroyed()) win.destroy(); });
    await win.loadURL("about:blank");
    if (protectedProfile) await applyFingerprint(win.webContents, normalizeFingerprint({ os: "windows", userAgent: `Mozilla/5.0 Chrome/${process.versions.chrome}`, aggressivePrivacyMode: false, webrtc: "proxy" }));
    else win.webContents.setWebRTCIPHandlingPolicy("default");
    await win.loadURL(`http://127.0.0.1:${plainPort}/advanced`);
    return { ses, bridge, wc: win.webContents };
  }
  const direct = await open(false);
  const protectedProfile = await open(true);

  // IPv6 origin remains live after the bridge is disposed, preventing a false
  // pass caused by an unavailable IPv6 stack or a dead target.
  let ipv6Hits = 0;
  const ipv6 = await listen(http.createServer((_req, res) => { ipv6Hits++; res.end("ipv6-fixture"); }), "::1");
  cleanups.push(() => ipv6.close()); allowedPorts.add(ipv6.port);
  const ipv6Url = `http://[::1]:${ipv6.port}/probe`;
  assert.equal(await (await protectedProfile.ses.fetch(ipv6Url)).text(), "ipv6-fixture");
  assert.ok(proxyDestinations.some(item => item.port === ipv6.port), "IPv6 request must reach proxy");
  const failed = await open(true);
  await failed.bridge.dispose();
  const before = ipv6Hits;
  await assert.rejects(failed.ses.fetch(ipv6Url, { signal: AbortSignal.timeout(2500) }));
  assert.equal(ipv6Hits, before, "IPv6 must not bypass failed proxy");
  assert.equal(await (await direct.ses.fetch(ipv6Url)).text(), "ipv6-fixture");
  process.stdout.write("ADVANCED_IPV6_OK loopback-proxy-and-failure\n");

  // Transport sentinels record TURN Allocate initiation, not a media relay.
  // TCP/TLS handshakes are counted even if certificate validation stops TLS.
  const sentinels = [];
  for (const family of ["udp4", "udp6"]) {
    const socket = dgram.createSocket(family); let attempts = 0;
    socket.on("message", message => { if (message.length >= 20 && message.readUInt16BE(0) === 3 && message.readUInt32BE(4) === 0x2112a442) attempts++; });
    await new Promise((resolve, reject) => { socket.once("error", reject); socket.bind(0, family === "udp4" ? "127.0.0.1" : "::1", resolve); });
    cleanups.push(() => new Promise(resolve => socket.close(resolve)));
    sentinels.push({ label: family, port: socket.address().port, url: `turn:${family === "udp4" ? "127.0.0.1" : "[::1]"}:${socket.address().port}?transport=udp`, attempts: () => attempts });
  }
  for (const transport of ["tcp", "tls"]) {
    let attempts = 0;
    const server = transport === "tls" ? tls.createServer(certificate) : net.createServer();
    server.on("connection", socket => { attempts++; socket.on("error", () => {}); socket.resume(); });
    server.on("tlsClientError", () => {});
    const listener = await listen(server); cleanups.push(() => listener.close()); allowedPorts.add(listener.port);
    sentinels.push({ label: transport, port: listener.port, url: `${transport === "tls" ? "turns" : "turn"}:127.0.0.1:${listener.port}?transport=tcp`, attempts: () => attempts });
  }
  for (const sentinel of sentinels) {
    const source = `(${iceProbe.toString()})(${JSON.stringify(sentinel.url)})`;
    await direct.wc.executeJavaScript(source);
    if (sentinel.label === "udp6" && sentinel.attempts() === 0) {
      process.stdout.write("ADVANCED_INCONCLUSIVE TURN-UDP6 positive control unavailable; IPv6 ICE route not verified\n");
      continue;
    }
    assert.ok(sentinel.attempts() > 0, `${sentinel.label}: direct control must reach TURN sentinel`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const start = sentinel.attempts();
    const proxyStart = proxyDestinations.filter(item => item.port === sentinel.port).length;
    const result = await protectedProfile.wc.executeJavaScript(source);
    await new Promise(resolve => setTimeout(resolve, 100));
    const delivered = sentinel.attempts() - start;
    const proxied = proxyDestinations.filter(item => item.port === sentinel.port).length - proxyStart;
    assert.deepEqual(result.types, [], "Sentinel never allocates a relay candidate");
    assert.ok(delivered === 0 || (sentinel.label !== "udp4" && sentinel.label !== "udp6" && proxied >= delivered), `${sentinel.label}: TURN must be blocked or go through authenticated proxy`);
    process.stdout.write(`ADVANCED_TURN ${sentinel.label} received=${delivered} proxied=${proxied}\n`);
    if (sentinel.label === "tcp" || sentinel.label === "tls") {
      // Make the upstream reject this destination while leaving the sentinel
      // alive. A direct fallback would still increment the sentinel counter.
      allowedPorts.delete(sentinel.port);
      const beforeFailure = sentinel.attempts();
      try {
        await protectedProfile.wc.executeJavaScript(source);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(sentinel.attempts(), beforeFailure, "Rejected TURN tunnel must not fall back to direct TCP/TLS");
      } finally { allowedPorts.add(sentinel.port); }
      process.stdout.write(`ADVANCED_TURN_FAIL_CLOSED ${sentinel.label}\n`);
    }
  }

  // NetLog is private to this disposable Electron process. No installed
  // profile, OS packet capture, cookie or real hostname is read or published.
  const socks = await mockSocks(plainPort); cleanups.push(() => socks.close());
  const dns = await open(true, { protocol: "socks5", host: "127.0.0.1", port: socks.port, username: "fixture-user", password: "fixture-pass" });
  const prefix = `audit-${randomUUID()}`;
  const names = [`${prefix}-fetch.invalid`, `${prefix}-hint.invalid`, `${prefix}-connect.invalid`, `${prefix}-frame.invalid`];
  const controlName = `${prefix}-control.localhost`;
  const logPath = path.join(directory, "network-audit.json");
  await dns.ses.netLog.startLogging(logPath, { captureMode: "default" });
  try {
    await dns.wc.executeJavaScript(`(async () => {
      const names = ${JSON.stringify(names)};
      for (const [rel, host] of [['dns-prefetch',names[1]],['preconnect',names[2]]]) {
        const link = document.createElement('link'); link.rel = rel; link.href = 'http://' + host + ':${plainPort}'; document.head.appendChild(link);
      }
      await fetch('http://' + names[0] + ':${plainPort}/dns', {mode:'no-cors'});
      await new Promise(resolve => { const f = document.createElement('iframe'); f.onload = resolve; f.src = 'http://' + names[3] + ':${plainPort}/frame'; document.body.appendChild(f); });
      await new Promise(resolve => setTimeout(resolve, 1500));
    })()`);
    await dns.ses.resolveHost(controlName);
  } finally { await dns.ses.netLog.stopLogging(); }
  const log = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.ok(resolverActivity(log, [controlName]).requests > 0, "NetLog must record the positive resolver control");
  const activity = resolverActivity(log, names);
  // This is a diagnostic, not a release claim of zero DNS leaks. Keep a
  // confirmed finding visible instead of hiding it behind a green suite.
  for (const [index, name] of names.entries()) {
    const detail = resolverActivity(log, [name]);
    process.stdout.write(`ADVANCED_DNS_${detail.network.length ? 'EXPOSURE' : 'LOCAL_ONLY'} kind=${['fetch','dns-prefetch','preconnect','iframe'][index]} tasks=${[...new Set(detail.tasks)].join(',')} networkEvents=${detail.network.length}\n`);
  }
  for (const name of [names[0], names[3]]) assert.ok(socks.observations.destinations.some(item => item.host === name), "Actual fetch/frame must reach SOCKS by name");
  process.stdout.write(`ADVANCED_DNS_RESULT requests=${activity.requests} networkEvents=${activity.network.length} capture=Chromium-only\n`);
}

module.exports = { auditAdvancedNetwork, resolverActivity };
