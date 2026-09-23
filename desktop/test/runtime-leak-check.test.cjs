const test = require("node:test");
const assert = require("node:assert/strict");
const { createLeakAudit, SAFE_WEBRTC } = require("../runtime/leak-check.cjs");

test("IP probe uses only the profile session and never certifies DNS or ICE", async () => {
  const ses = {};
  let calls = 0;
  const audit = createLeakAudit({ net: {}, session: { fromPartition() { throw new Error("direct session forbidden"); } } }, {
    requestJson: async (_net, actual) => { assert.equal(actual, ses); calls++; return { ip: "203.0.113.1" }; },
  });
  const result = await audit({ ses, hasProxy: true, webrtcPolicy: SAFE_WEBRTC });
  assert.equal(calls, 1);
  assert.equal(result.ip, "203.0.113.1");
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.leaked, false);
  assert.ok(result.checks.every((check) => check.state === "unknown"));
  assert.equal(result.directIp, undefined);
});

test("failed probes are not converted into a green leak result", async () => {
  const audit = createLeakAudit({ net: {} }, { requestJson: async () => { throw new Error("offline"); } });
  const result = await audit({ ses: {}, hasProxy: true, webrtcPolicy: SAFE_WEBRTC });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.checks.find((check) => check.id === "ip").state, "error");
});

test("unsafe WebRTC policy blocks before sending probes", async () => {
  const ses = { closeAllConnections: async () => {} };
  let blocked;
  const audit = createLeakAudit({ net: {} }, {
    blockSession: (session) => { blocked = session; },
    requestJson: async () => { assert.fail("blocked session must not probe"); },
  });
  const result = await audit({ ses, hasProxy: true, webrtcPolicy: "default" });
  assert.equal(blocked, ses);
  assert.equal(result.leaked, true);
  assert.equal(result.ok, false);
});

test("direct mode warns without contacting probe services", async () => {
  const audit = createLeakAudit({ net: {} }, { requestJson: async () => assert.fail("unexpected probe") });
  const result = await audit({ ses: {}, hasProxy: false });
  assert.equal(result.ok, false);
  assert.ok(result.checks.every((check) => check.state === "skip"));
  assert.match(result.checks[0].detail, /сайт видит адрес/);
});
