// Local transport probes; no user profiles, public STUN service or raw ICE
// addresses in output. A positive control prevents a broken fixture passing.
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { randomUUID } = require("node:crypto");
const { createRuntimeProxy } = require("../runtime/proxy.cjs");
const { applyFingerprint, normalizeFingerprint } = require("../runtime/fingerprint.cjs");
const { mockSocks } = require("./runtime-proxy-fixtures.cjs");

async function gatherIce(stunUrl) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
  try {
    pc.createDataChannel("local-audit");
    const types = [];
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    pc.onicecandidate = event => { if (event.candidate) types.push(event.candidate.type); };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") finish(true); };
    const timer = setTimeout(() => finish(false), 3000);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      return { complete: await done, candidateTypes: types };
    } finally { clearTimeout(timer); }
  } finally { pc.close(); }
}

async function auditNetworkPrivacy({ electron, plainPort, proxy, cleanups }) {
  const { session, BrowserWindow } = electron;
  // Reserved, unique name which only the synthetic SOCKS server maps to origin.
  // This proves target-name forwarding, not absence of speculative DNS packets.
  const socks = await mockSocks(plainPort); cleanups.push(() => socks.close());
  const remoteName = `umbra-${randomUUID()}.invalid`;
  const dnsSession = session.fromPartition(`dns-${randomUUID()}`);
  const dnsBridge = await createRuntimeProxy(dnsSession, { protocol: "socks5", host: "127.0.0.1", port: socks.port, username: "fixture-user", password: "fixture-pass" });
  cleanups.push(() => dnsBridge.dispose());
  assert.match(await (await dnsSession.fetch(`http://${remoteName}:${plainPort}/remote-name`, { signal: AbortSignal.timeout(3000) })).text(), /HTTP through proxy/);
  assert.ok(socks.observations.destinations.some(item => item.host === remoteName && item.port === plainPort), "SOCKS must receive the unresolved target hostname");
  await dnsBridge.dispose();

  const stun = dgram.createSocket("udp4");
  let requests = 0;
  stun.on("message", (message, peer) => {
    if (message.length < 20 || message.readUInt16BE(0) !== 1 || message.readUInt32BE(4) !== 0x2112a442) return;
    requests++;
    // RFC 5389 Binding Success + XOR-MAPPED-ADDRESS. Loopback peers only.
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2);
    message.copy(response, 4, 4, 20);
    response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22);
    response[25] = 1; response.writeUInt16BE(peer.port ^ 0x2112, 26);
    const address = peer.address.split(".").map(Number);
    const cookie = [0x21, 0x12, 0xa4, 0x42];
    for (let i = 0; i < 4; i++) response[28 + i] = address[i] ^ cookie[i];
    stun.send(response, peer.port, peer.address);
  });
  await new Promise((resolve, reject) => { stun.once("error", reject); stun.bind(0, "127.0.0.1", resolve); });
  cleanups.push(() => new Promise(resolve => stun.close(resolve)));
  const source = `(${gatherIce.toString()})(${JSON.stringify(`stun:127.0.0.1:${stun.address().port}`)})`;
  async function windowFor(protectedProfile) {
    const ses = session.fromPartition(`rtc-${randomUUID()}`);
    const bridge = await createRuntimeProxy(ses, protectedProfile ? proxy : null);
    cleanups.push(() => bridge.dispose());
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    cleanups.push(async () => { if (!win.isDestroyed()) win.destroy(); });
    await win.loadURL("about:blank");
    if (protectedProfile) {
      await applyFingerprint(win.webContents, normalizeFingerprint({ os: "windows", userAgent: `Mozilla/5.0 Chrome/${process.versions.chrome}`, aggressivePrivacyMode: false, webrtc: "proxy" }));
    } else {
      // Only this temporary local control is unprotected, never the application.
      win.webContents.setWebRTCIPHandlingPolicy("default");
    }
    await win.loadURL(`http://127.0.0.1:${plainPort}/rtc`);
    return win.webContents;
  }
  const control = await windowFor(false);
  await control.executeJavaScript(source);
  assert.ok(requests > 0, "Positive control must contact local STUN; no packets is otherwise inconclusive");
  // Close the control peer before the protected trial and let queued UDP drain.
  await new Promise(resolve => setTimeout(resolve, 100));
  const protectedContents = await windowFor(true);
  assert.equal(protectedContents.getWebRTCIPHandlingPolicy(), "disable_non_proxied_udp");
  const before = requests;
  const result = await protectedContents.executeJavaScript(source);
  assert.equal(result.complete, true, "ICE must finish rather than silently time out");
  assert.deepEqual(result.candidateTypes, [], "No direct candidates without a proxied TURN server");
  assert.equal(requests, before, "Protected WebRTC must not send direct STUN UDP");
  await protectedContents.executeJavaScript(`new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.onload = () => resolve(true); frame.onerror = () => reject(new Error('Local iframe failed'));
    frame.src = 'http://localhost:${plainPort}/rtc-frame'; document.body.appendChild(frame);
  })`);
  const child = protectedContents.mainFrame.frames.find(frame => frame.url.includes("/rtc-frame"));
  assert.ok(child);
  const frameResult = await child.executeJavaScript(source);
  assert.equal(frameResult.complete, true);
  assert.deepEqual(frameResult.candidateTypes, []);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, before, "Cross-origin iframe must not send direct STUN UDP");
  process.stdout.write("NATIVE_NETWORK_PRIVACY_OK remote-SOCKS-name local-STUN-positive-control protected-main-and-frame\n");
}

module.exports = { auditNetworkPrivacy };
