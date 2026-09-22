const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createCookieStore, initializeCookies, parseCookieImport, restoreCookies, applyImportedCookies } = require("../runtime/cookies.cjs");
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

test("confirmed cloud cookies override local cache while unversioned launches keep local data", async () => {
  let local = { cookies: [cookie("local")], cookiesUpdatedAt: NEW };
  const store = { read: async () => local, write: async (_id, cookies, cookiesUpdatedAt) => { local = { cookies, cookiesUpdatedAt }; } };
  for (const cookiesUpdatedAt of [OLD, NEW]) {
    local = { cookies: [cookie("local")], cookiesUpdatedAt: NEW };
    const ses = session();
    const result = await initializeCookies(ses, store, { profileId: ID, cookies: JSON.stringify([cookie("cloud")]), cookiesUpdatedAt });
    assert.equal((await ses.cookies.get({}))[0].value, "cloud");
    assert.equal(result.source, "cloud");
  }

  local = { cookies: [cookie("local")], cookiesUpdatedAt: NEW };
  const unversioned = session();
  const localResult = await initializeCookies(unversioned, store, { profileId: ID, cookies: JSON.stringify([cookie("cloud")]), cookiesUpdatedAt: null });
  assert.equal((await unversioned.cookies.get({}))[0].value, "local");
  assert.equal(localResult.source, "local");

  const ses = session([cookie("native")]);
  local = { cookies: [cookie("local")], cookiesUpdatedAt: NEW };
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
  assert.deepEqual(result, { restored: 1, skipped: 1, expired: 0, installed: 1 });
  assert.equal((await ses.cookies.get({}))[0].name, "working");
});

test("failed cookie restore does not overwrite the encrypted snapshot", async () => {
  let writes = 0;
  const store = { read: async () => null, write: async () => { writes += 1; } };
  const ses = session();
  ses.cookies.set = async () => { throw new Error("Chromium rejected cookie"); };
  await assert.rejects(initializeCookies(ses, store, {
    profileId: ID, cookies: JSON.stringify([cookie("preserve")]), cookiesUpdatedAt: NEW,
  }), /Unable to restore imported cookies/);
  assert.equal(writes, 0);
});

test("expired cloud cookies are reported and never silently replaced by an empty snapshot", async () => {
  let writes = 0;
  const store = { read: async () => null, write: async () => { writes += 1; } };
  await assert.rejects(initializeCookies(session(), store, {
    profileId: ID, cookies: JSON.stringify([{ ...cookie("expired"), session: false, expirationDate: 100 }]), cookiesUpdatedAt: NEW,
  }), /Unable to restore imported cookies/);
  assert.equal(writes, 0);
});

test("successful cloud restore reports retained cookie count", async () => {
  const store = { read: async () => null, write: async () => {} };
  const result = await initializeCookies(session(), store, {
    profileId: ID, cookies: JSON.stringify([cookie("working")]), cookiesUpdatedAt: NEW,
  });
  assert.deepEqual(result.cookieRestore, { installed: 1, total: 1, expired: 0 });
});

test("cookie import accepts JSON exports and Netscape files", () => {
  const json = parseCookieImport(JSON.stringify({ cookies: [{
    domain: ".example.test", name: "json-session", value: "secret", path: "/account",
    secure: true, httpOnly: true, sameSite: "None", expirationDate: 2_000_000_000,
  }] }));
  assert.deepEqual(json[0], {
    name: "json-session", value: "secret", domain: ".example.test", path: "/account",
    hostOnly: false, secure: true, httpOnly: true, session: false,
    expirationDate: 2_000_000_000, sameSite: "no_restriction",
  });
  const netscape = parseCookieImport([
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.example.test\tTRUE\t/\tTRUE\t2000000000\tnet-session\t",
  ].join("\n"));
  assert.equal(netscape[0].name, "net-session");
  assert.equal(netscape[0].value, "");
  assert.equal(netscape[0].httpOnly, true);
  assert.equal(netscape[0].hostOnly, false);
});

test("cookie import merges into the live session and reports rejected entries", async () => {
  const ses = session([cookie("existing")]);
  const originalSet = ses.cookies.set;
  ses.cookies.set = async (details) => {
    if (details.name === "rejected") throw new Error("invalid for Chromium");
    return originalSet(details);
  };
  const result = await applyImportedCookies(ses, parseCookieImport(JSON.stringify([
    { domain: "example.test", path: "/", name: "accepted", value: "1" },
    { domain: "example.test", path: "/", name: "rejected", value: "2" },
  ])));
  assert.deepEqual(result, { imported: 1, skipped: 1 });
  assert.equal((await ses.cookies.get({})).some((entry) => entry.value === "existing"), true);
  assert.equal(ses.writes.at(-1).name, "accepted");
});

test("cookie import rejects empty, malformed and oversized input", () => {
  for (const value of ["", "not a netscape row", "{}", JSON.stringify([{ domain: "", name: "a", value: "b" }])]) {
    assert.throws(() => parseCookieImport(value));
  }
  assert.throws(() => parseCookieImport("x".repeat(5_000_001)), /5 МБ/);
});

test("encryption unavailable/basic_text fails closed", async () => {
  for (const safeStorage of [{ isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" }]) {
    const store = createCookieStore({ safeStorage, userData: os.tmpdir() });
    await assert.rejects(store.read(ID), /encryption/);
    await assert.rejects(store.write(ID, [], NEW), /encryption/);
  }
});
