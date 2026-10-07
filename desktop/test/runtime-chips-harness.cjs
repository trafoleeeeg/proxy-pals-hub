const { app, session, safeStorage } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { initializeBackgroundWorkers, allowBackgroundWorkers, protectBackgroundWorkers, cookieProtocolForSession } = require("../runtime/background-workers.cjs");
const { createCookieTransport } = require("../runtime/cookie-transport.cjs");
const { registerCookieTransport, readSessionCookies, restoreCookies, createCookieStore, initializeCookies, parseCookieImport, disposeCookieTransport } = require("../runtime/cookies.cjs");
const directory = process.env.UMBRA_CHIPS_TEST_DIR;
const phase = process.env.UMBRA_CHIPS_TEST_PHASE;
assert.ok(directory);
app.setPath("userData", path.join(directory, "user"));
app.setPath("sessionData", path.join(directory, "sessions"));
app.enableSandbox();
app.on("window-all-closed", () => {});
app.commandLine.appendSwitch("disable-background-networking");
const id = "10000000-0000-4000-8000-000000000088";
const revision = "2026-01-01T00:00:00.000Z";
const base = { name: "duplicate", value: "synthetic-chips-only", domain: "chips.test", path: "/", hostOnly: true,
  session: true, secure: true, httpOnly: true, sameSite: "no_restriction" };
const cookies = [base, ...[{ topLevelSite: "https://chips.test", hasCrossSiteAncestor: false },
  { topLevelSite: "https://chips.test", hasCrossSiteAncestor: true },
  { topLevelSite: "https://other.test", hasCrossSiteAncestor: true }].map(partitionKey => ({ ...base, partitionKey }))];
const keys = rows => rows.map(cookie => JSON.stringify(cookie.partitionKey || null)).sort();
app.whenReady().then(async () => {
  await initializeBackgroundWorkers();
  let protection = safeStorage;
  if (process.platform === "win32") assert.ok(safeStorage.isEncryptionAvailable(), "Native DPAPI required");
  else {
    const crypto = require("node:crypto");
    const key = crypto.createHash("sha256").update("synthetic CHIPS fixture only").digest();
    protection = { isEncryptionAvailable: () => true,
      encryptString(value) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
      decryptString(value) { const c = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(); } };
  }
  const store = createCookieStore({ userData: directory, safeStorage: protection });
  const a = session.fromPartition("persist:chips-a"), b = session.fromPartition("persist:chips-b");
  let workers;
  let transport;
  for (const ses of [a, b]) {
    ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    if (ses === a) workers = await protectBackgroundWorkers(ses, {});
    else await allowBackgroundWorkers(ses);
    const bridge = createCookieTransport(cookieProtocolForSession(ses));
    if (ses === a) transport = bridge;
    registerCookieTransport(ses, bridge);
  }
  if (phase === "initial") {
    const restored = await restoreCookies(a, parseCookieImport(JSON.stringify(cookies)));
    assert.equal(restored.installed, 4, "ordinary + three exact partitions must coexist");
    await workers.stop();
    // Closing workers must leave the blank cookie guard until the durable save.
    const actual = await readSessionCookies(a);
    assert.deepEqual(keys(actual), keys(cookies));
    assert.equal((await readSessionCookies(b)).length, 0, "another profile must stay empty");
    await store.write(id, actual, "2026-01-02T00:00:00.000Z", { pending: true, baseRevision: revision });
    const encrypted = await fs.readFile(path.join(directory, "profile-cookie-snapshots", id + ".bin"));
    assert.equal(encrypted.includes(Buffer.from(base.value)), false);
    assert.deepEqual(keys((await store.read(id)).cookies), keys(cookies));
  } else {
    const result = await initializeCookies(a, store, { profileId: id, cookies: "[]", cookiesUpdatedAt: revision });
    assert.equal(result.cookieRestore.installed, 4);
    assert.deepEqual(keys(await readSessionCookies(a)), keys(cookies));
    assert.equal((await readSessionCookies(b)).length, 0);
    await workers.stop();
    assert.deepEqual(keys(await readSessionCookies(a)), keys(cookies));
  }
  disposeCookieTransport(a);
  await assert.rejects(transport.read(), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
  console.log("UMBRA_CHIPS_NATIVE_OK " + phase);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
