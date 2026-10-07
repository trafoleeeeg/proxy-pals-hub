const test = require("node:test");
const assert = require("node:assert/strict");
const { createCookieTransport, exportedCookie, protocolCookie } = require("../runtime/cookie-transport.cjs");
const cookie = { name: "synthetic", value: "synthetic-secret", domain: "test.example", path: "/", secure: true,
  httpOnly: true, hostOnly: true, session: false, expirationDate: 2000000000, sameSite: "no_restriction",
  partitionKey: { topLevelSite: "https://example.test", hasCrossSiteAncestor: true } };

test("CDP cookie conversion preserves expiry, SameSite, scope and partition", () => {
  const details = protocolCookie(cookie);
  assert.equal(details.domain, undefined);
  assert.equal(details.sameSite, "None");
  assert.equal(details.expires, cookie.expirationDate);
  assert.deepEqual(exportedCookie({ ...details, domain: cookie.domain, session: false }), cookie);
  assert.equal(protocolCookie({ ...cookie, domain: ".example.test", hostOnly: false }).domain, ".example.test");
  assert.throws(() => exportedCookie({ ...details, domain: cookie.domain, partitionKeyOpaque: true }), /CHIPS/);
});

test("timed out cookie transport fails promptly and cannot accept a late result", async () => {
  let release, calls = 0;
  const transport = createCookieTransport({ write: () => { calls++; return new Promise(resolve => { release = resolve; }); } }, { timeoutMs: 5 });
  await assert.rejects(transport.write(cookie), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
  release({});
  await assert.rejects(transport.write(cookie), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
  assert.equal(calls, 1);
});

test("a transient read failure can be retried without accepting the late snapshot", async () => {
  let release, calls = 0;
  const transport = createCookieTransport({ read: () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ cookies: [] }) }, { timeoutMs: 5 });
  await assert.rejects(transport.read(), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
  assert.deepEqual(await transport.read(), []);
  release({ cookies: [{ ...protocolCookie(cookie), domain: cookie.domain, session: false }] });
  assert.deepEqual(await transport.read(), []);
});

test("cookie protocol errors never expose values and disposed transport cannot be reused", async () => {
  let disposed = false;
  const transport = createCookieTransport({ write: async () => { throw new Error(cookie.value); }, dispose: () => { disposed = true; } });
  await assert.rejects(transport.write(cookie), error => error.message === "Cookie rejected by Chromium" && !error.message.includes(cookie.value));
  transport.dispose();
  assert.equal(disposed, true);
  await assert.rejects(transport.write(cookie), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
});
