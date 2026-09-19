const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createCookieStore, initializeCookies, restoreCookies } = require("../runtime/cookies.cjs");
const { profileId, startUrl, proxyConfig } = require("../runtime/validation.cjs");
const ID = "10000000-0000-4000-8000-000000000001";
const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-02-01T00:00:00.000Z";
const cookie = (value) => ({ name: "session", value, domain: "localhost", path: "/", hostOnly: true, session: true, secure: true, httpOnly: true, sameSite: "lax" });

function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString();
    },
  };
}

function session(initial = []) {
  let data = initial;
  const writes = [];
  return {
    writes,
    clearStorageData: async () => { data = []; },
    cookies: {
      get: async () => data,
      flushStore: async () => {},
      set: async (details) => {
        writes.push(details);
        data.push({ ...details, domain: details.domain || new URL(details.url).hostname, hostOnly: !details.domain, session: details.expirationDate == null });
      },
    },
  };
}

test("UUID, URL and proxy validation reject path/credential injection", () => {
  assert.equal(profileId(ID.toUpperCase()), ID);
  for (const id of ["../elsewhere", "not-a-uuid", ID + "/..", "10000000-0000-0000-0000-000000000001"]) assert.throws(() => profileId(id));
  for (const url of ["file:///C:/Windows", "javascript:alert(1)", "https://a:b@host/", "data:text/html,test"]) assert.throws(() => startUrl(url));
  assert.equal(startUrl("https://example.test/a"), "https://example.test/a");
  for (const value of [{}, { protocol: "ftp", port: 1, host: "localhost" }, { protocol: "http", port: 0, host: "localhost" }, { protocol: "http", port: 80, host: "host@attacker" }]) assert.throws(() => proxyConfig(value));
  const proxy = proxyConfig({ protocol: "socks5", host: "::1", port: 1080, username: "u:@", password: "p?#" });
  assert.equal(new URL(proxy.url).protocol, "socks5h:");
  assert.equal(decodeURIComponent(new URL(proxy.url).password), "p?#");
});

test("encrypted snapshots retain session cookies and reject tampering without overwrite", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-cookie-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createCookieStore({ safeStorage: encryption(), userData: directory });
  await store.write(ID, [cookie("private-cookie-value")], NEW);
  const filename = path.join(directory, "profile-cookie-snapshots", `${ID}.bin`);
  const encrypted = await fs.readFile(filename);
  assert.equal(encrypted.includes(Buffer.from("private-cookie-value")), false);
  assert.equal((await store.read(ID)).cookies[0].session, true);
  assert.equal((await store.read(ID)).cookies[0].value, "private-cookie-value");
  encrypted[encrypted.length - 1] ^= 1;
  await fs.writeFile(filename, encrypted);
  await assert.rejects(store.read(ID), /decrypt/);
  await assert.rejects(initializeCookies(session(), store, { profileId: ID, cookies: "[]", cookiesUpdatedAt: NEW }), /decrypt/);
  assert.deepEqual(await fs.readFile(filename), encrypted);
});

test("old/unversioned cloud cookies cannot replace newer local data; newer empty revision removes cookies", async () => {
  let local = { cookies: [cookie("new")], cookiesUpdatedAt: NEW };
  const store = { read: async () => local, write: async (_id, cookies, cookiesUpdatedAt) => { local = { cookies, cookiesUpdatedAt }; } };
  for (const cookiesUpdatedAt of [OLD, NEW, null]) {
    const ses = session();
    const result = await initializeCookies(ses, store, { profileId: ID, cookies: JSON.stringify([cookie("old")]), cookiesUpdatedAt });
    assert.equal((await ses.cookies.get({}))[0].value, "new");
    assert.equal(result.source, "local");
  }
  const ses = session([cookie("native")]);
  await initializeCookies(ses, store, { profileId: ID, cookies: "[]", cookiesUpdatedAt: "2026-03-01T00:00:00Z" });
  assert.deepEqual(await ses.cookies.get({}), []);
});

test("host-only and session attributes survive restore, expiration is omitted", async () => {
  const ses = session();
  await restoreCookies(ses, [cookie("value"), { ...cookie("domain"), name: "domain", hostOnly: false, domain: ".example.test" }]);
  assert.equal(Object.hasOwn(ses.writes[0], "domain"), false);
  assert.equal(Object.hasOwn(ses.writes[0], "expirationDate"), false);
  assert.equal(ses.writes[0].httpOnly, true);
  assert.equal(ses.writes[1].domain, ".example.test");
});

test("one Chromium-incompatible cookie does not block the whole profile", async () => {
  const ses = session();
  const originalSet = ses.cookies.set;
  ses.cookies.set = async (details) => {
    if (details.name === "obsolete") throw new Error("Failed to set cookie");
    return originalSet(details);
  };
  const result = await restoreCookies(ses, [
    { ...cookie("old"), name: "obsolete" },
    { ...cookie("working"), name: "working" },
  ]);
  assert.deepEqual(result, { restored: 1, skipped: 1 });
  assert.equal((await ses.cookies.get({}))[0].name, "working");
});

test("encryption unavailable/basic_text fails closed", async () => {
  for (const safeStorage of [{ isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" }]) {
    const store = createCookieStore({ safeStorage, userData: os.tmpdir() });
    await assert.rejects(store.read(ID), /encryption/);
    await assert.rejects(store.write(ID, [], NEW), /encryption/);
  }
});
