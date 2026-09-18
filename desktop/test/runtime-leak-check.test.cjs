const test = require("node:test");
const assert = require("node:assert/strict");
const { createLeakAudit, SAFE_WEBRTC } = require("../runtime/leak-check.cjs");

function fakeSession() {
  return {
    fromPartition: () => ({
      setProxy: async () => {},
      closeAllConnections: async () => {},
      clearStorageData: async () => {},
      clearCache: async () => {},
    }),
  };
}

function audit({ direct = "5.5.5.5", profile = "9.9.9.9", dns = "9.9.9.9", blocked = [] }) {
  let call = 0;
  return createLeakAudit({ session: fakeSession(), net: {} }, {
    blockSession: (ses) => blocked.push(ses),
    requestJson: async (_net, ses, url) => {
      call++;
      if (!ses.profile) return { ip: direct };
      return url.includes("edns") ? { dns: { ip: dns } } : { ip: profile };
    },
  });
}

test("чистый прокси не даёт утечек", async () => {
  const blocked = [];
  const run = audit({ blocked });
  const result = await run({ ses: { profile: true }, hasProxy: true, webrtcPolicy: SAFE_WEBRTC });
  assert.equal(result.leaked, false);
  assert.equal(result.ok, true);
  assert.equal(blocked.length, 0);
  assert.equal(result.checks.find((c) => c.id === "ip").state, "ok");
});

test("совпадение с реальным адресом блокирует трафик", async () => {
  const blocked = [];
  const run = audit({ direct: "5.5.5.5", profile: "5.5.5.5", dns: "5.5.5.5", blocked });
  const ses = { profile: true, closeAllConnections: async () => {} };
  const result = await run({ ses, hasProxy: true, webrtcPolicy: SAFE_WEBRTC });
  assert.equal(result.leaked, true);
  assert.equal(blocked[0], ses);
  assert.equal(result.checks.find((c) => c.id === "dns").state, "leak");
});

test("небезопасная политика WebRTC считается утечкой", async () => {
  const blocked = [];
  const run = audit({ blocked });
  const result = await run({ ses: { profile: true, closeAllConnections: async () => {} }, hasProxy: true, webrtcPolicy: "default" });
  assert.equal(result.checks.find((c) => c.id === "webrtc").state, "leak");
  assert.equal(result.leaked, true);
});

test("без прокси проверки пропускаются", async () => {
  const run = audit({});
  const result = await run({ ses: { profile: true }, hasProxy: false });
  assert.equal(result.leaked, false);
  assert.ok(result.checks.every((check) => check.state === "skip"));
});
