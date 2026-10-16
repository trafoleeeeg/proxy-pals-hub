const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createCookieStore, initializeCookies, parseCookieImport, restoreCookies, applyImportedCookies, registerCookieTransport, readSessionCookies } = require("../runtime/cookies.cjs");
const { profileId, startUrl, proxyConfig } = require("../runtime/validation.cjs");
const ID = "10000000-0000-4000-8000-000000000001";
const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-02-01T00:00:00.000Z";
const cookie = (value) => ({ name: "session", value, domain: "localhost", path: "/", hostOnly: true, session: true, secure: true, httpOnly: true, sameSite: "lax" });

test("unsupported CHIPS import and restore fail before clearing cookies", async () => {
  for (const fields of [{ partitionKey: {} }, { partitioned: true }, { partitionKeyOpaque: true }]) {
    const input = { ...cookie("synthetic-value"), ...fields };
    assert.throws(() => parseCookieImport(JSON.stringify([input])), /CHIPS/);
    let cleared = false;
    await assert.rejects(restoreCookies({ clearStorageData: async () => { cleared = true; } }, [input]), /CHIPS/);
    assert.equal(cleared, false);
  }
});

test("CHIPS require a partition-aware transport before clearing or writing", async () => {
  const input = { ...cookie("synthetic"), partitionKey: { topLevelSite: "https://site.test", hasCrossSiteAncestor: true } };
  assert.equal(parseCookieImport(JSON.stringify([input]))[0].partitionKey.hasCrossSiteAncestor, true);
  let cleared = false, written = false;
  const ses = { clearStorageData: async () => { cleared = true; }, cookies: { set: async () => { written = true; } } };
  await assert.rejects(restoreCookies(ses, [input]), /CHIPS/);
  await assert.rejects(applyImportedCookies(ses, [input]), /CHIPS/);
  assert.equal(cleared, false); assert.equal(written, false);
});

test("retained counts never confuse partitioned cookies with ordinary or another ancestor bit", async () => {
  const ordinary = cookie("same-synthetic-value");
  const chip = { ...ordinary, partitionKey: { topLevelSite: "https://site.test", hasCrossSiteAncestor: true } };
  const ses = session();
  registerCookieTransport(ses, { read: async () => [ordinary], write: async () => {} });
  await assert.rejects(applyImportedCookies(ses, [chip]), /ни одного/);
  registerCookieTransport(ses, { read: async () => [{ ...chip, partitionKey: { ...chip.partitionKey, hasCrossSiteAncestor: false } }], write: async () => {} });
  await assert.rejects(applyImportedCookies(ses, [chip]), /ни одного/);
  registerCookieTransport(ses, { read: async () => [chip], write: async () => {} });
  assert.equal((await applyImportedCookies(ses, [chip])).imported, 1);
  assert.deepEqual((await readSessionCookies(ses))[0].partitionKey, chip.partitionKey);
});

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

test("partial CHIPS restore cannot overwrite its recoverable snapshot", async () => {
  const ordinary = cookie("synthetic");
  const chips = { ...ordinary, partitionKey: { topLevelSite: "https://example.test", hasCrossSiteAncestor: true } };
  const ses = session();
  let rows = [], writes = 0;
  ses.clearStorageData = async () => { rows = []; };
  registerCookieTransport(ses, { read: async () => rows, write: async entry => { if (!entry.partitionKey) rows.push(entry); } });
  await assert.rejects(initializeCookies(ses, { read: async () => null, write: async () => { writes++; } },
    { profileId: ID, cookies: JSON.stringify([ordinary, chips]), cookiesUpdatedAt: NEW }), { code: "COOKIE_RESTORE_FAILED" });
  assert.equal(writes, 0);
  assert.equal(rows.length, 0, "failed CHIPS restore rolls back the ordinary cookies too");
});

test("transport failure aborts import instead of swallowing a timeout for every cookie", async () => {
  const ses = session();
  let calls = 0;
  registerCookieTransport(ses, { read: async () => [], write: async () => { calls++; throw Object.assign(new Error("unavailable"), { code: "COOKIE_TRANSPORT_UNAVAILABLE" }); } });
  await assert.rejects(applyImportedCookies(ses, [cookie("one"), cookie("two")]), { code: "COOKIE_TRANSPORT_UNAVAILABLE" });
  assert.equal(calls, 1);
});

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

test("unclean checkpoint restores local cookies against the exact cloud base, not machine clocks", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-cookie-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createCookieStore({ safeStorage: encryption(), userData: directory });
  // Even a locally older timestamp must win when based on this exact cloud revision.
  await store.write(ID, [cookie("local-checkpoint")], OLD, { pending: true, baseRevision: NEW });
  const result = await initializeCookies(session(), store, { profileId: ID, cookiesUpdatedAt: NEW, cookies: JSON.stringify([cookie("cloud-base")]) });
  assert.equal(result.source, "local-recovery");
  assert.equal((await store.read(ID)).cookies[0].value, "local-checkpoint");
  assert.equal((await store.read(ID)).pending, true);
  await store.markClosed(ID);
  assert.equal((await store.read(ID)).pending, undefined);
});

test("conflicting cloud import cannot overwrite an unclean checkpoint or native cookies", async () => {
  const local = { cookies: [cookie("local")], cookiesUpdatedAt: NEW, pending: true, baseRevision: OLD };
  const ses = session([cookie("native")]);
  let written = false;
  const store = { read: async () => local, write: async () => { written = true; } };
  await assert.rejects(initializeCookies(ses, store, { profileId: ID, cookiesUpdatedAt: "2026-03-01T00:00:00.000Z", cookies: "[]" }), /recovery conflict/);
  assert.equal(written, false);
  assert.equal((await ses.cookies.get({}))[0].value, "native");
});

test("a closure acknowledgement cleans only its exact durable checkpoint", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-cookie-close-ack-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createCookieStore({ safeStorage: encryption(), userData: directory });
  await store.write(ID, [cookie("latest")], NEW, { pending: true, baseRevision: OLD });
  const filename = path.join(directory, "profile-cookie-snapshots", `${ID}.bin`);
  const initial = await fs.readFile(filename);
  for (const [cookies, cookiesUpdatedAt] of [
    [JSON.stringify([cookie("latest")]), OLD],
    [JSON.stringify([cookie("older")]), NEW],
    ["[]", NEW],
    [null, null],
  ]) {
    assert.equal(await store.acknowledgeClosed(ID, cookies, cookiesUpdatedAt), false);
    assert.deepEqual(await fs.readFile(filename), initial, "stale acknowledgements cannot rewrite encrypted bytes");
  }
  assert.equal(await store.acknowledgeClosed(ID, JSON.stringify([cookie("latest")]), NEW), true);
  const confirmed = await store.read(ID);
  assert.equal(confirmed.pending, undefined);
  assert.equal(confirmed.cookiesUpdatedAt, NEW);
  assert.equal(confirmed.cookies[0].value, "latest");
  assert.equal(await store.acknowledgeClosed(ID, JSON.stringify([cookie("latest")]), NEW), false);
});

test("a saved cloud copy recovers an unacknowledged crash checkpoint by complete contents", async () => {
  for (const cookies of [[cookie("saved-before-crash"), { ...cookie("second"), name: "second" }], []]) {
    let local = { cookies, cookiesUpdatedAt: NEW, pending: true, baseRevision: OLD };
    const cloudRevision = "2026-03-01T00:00:00.123456+00:00";
    const store = { read: async () => local, write: async (_id, saved, cookiesUpdatedAt, recovery) => { local = { cookies: saved, cookiesUpdatedAt, ...recovery }; } };
    const result = await initializeCookies(session(), store, {
      profileId: ID, cookies: JSON.stringify([...cookies].reverse()), cookiesUpdatedAt: cloudRevision,
    });
    assert.equal(result.source, "cloud");
    assert.equal(local.cookiesUpdatedAt, "2026-03-01T00:00:00.123Z");
    assert.equal(local.baseRevision, local.cookiesUpdatedAt);
    assert.equal(local.pending, true, "the new running session still needs crash recovery");
    assert.equal(local.cookies.length, cookies.length);
  }
});

test("coincident timestamps and a changed cloud base cannot authorize different cookies", async () => {
  for (const cookies of [[cookie("cloud")], [], [{ ...cookie("local"), httpOnly: false }]]) {
    const local = { cookies: [cookie("local")], cookiesUpdatedAt: NEW, pending: true, baseRevision: OLD };
    const ses = session([cookie("native")]);
    let writes = 0;
    const store = { read: async () => local, write: async () => { writes++; } };
    await assert.rejects(initializeCookies(ses, store, {
      profileId: ID, cookies: JSON.stringify(cookies), cookiesUpdatedAt: NEW,
    }), /recovery conflict/);
    assert.equal(writes, 0);
    assert.equal(ses.writes.length, 0);
    assert.equal((await ses.cookies.get({}))[0].value, "native");
    assert.equal(local.cookies[0].value, "local");
  }
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

test("one rejected active cookie aborts startup and restores the original native session", async () => {
  const ses = session([{ ...cookie("original-session"), name: "original" }]);
  const originalSet = ses.cookies.set;
  ses.cookies.set = async (details) => {
    if (details.name === "obsolete") throw new Error("Failed to set cookie");
    return originalSet(details);
  };
  await assert.rejects(restoreCookies(ses, [
    { ...cookie("working"), name: "working" },
    { ...cookie("old"), name: "obsolete" },
  ]), { code: "COOKIE_RESTORE_FAILED" });
  assert.equal((await ses.cookies.get({})).length, 1);
  assert.equal((await ses.cookies.get({}))[0].value, "original-session");
});

test("persistent restore accepts only native microsecond conversion and bounded lifetime caps", async () => {
  for (const [secure, lifetime] of [[true, null], [true, 400 * 86400], [false, 400 * 86400], [false, 3 * 3600]]) {
    const ses = session();
    const originalSet = ses.cookies.set;
    const requested = { ...cookie("persistent"), session: false, secure,
      expirationDate: Math.floor(Date.now() / 1000) + (lifetime ? 3 * 365 * 86400 : 30 * 86400) + 0.1234567 };
    ses.cookies.set = details => originalSet({ ...details, expirationDate: lifetime
      ? Math.min(details.expirationDate, Date.now() / 1000 + lifetime)
      : Math.trunc(details.expirationDate * 1e6) / 1e6 });
    assert.equal((await restoreCookies(ses, [requested])).installed, 1);
    assert.equal((await ses.cookies.get({}))[0].session, false);
  }
});

test("Windows coarse JS clock does not reject the native 400-day cap", { skip: process.platform !== "win32" }, async t => {
  // Node/V8's clock is based on GetSystemTimeAsFileTime (~15.625 ms), while
  // Chromium's cookie clock uses GetSystemTimePreciseAsFileTime. Model one
  // native timestamp falling ahead of the unchanged coarse JS clock tick.
  const coarseNow = 1_800_000_000_000;
  t.mock.method(Date, "now", () => coarseNow);
  const requested = { ...cookie("persistent"), session: false,
    expirationDate: coarseNow / 1000 + 3 * 365 * 86400 };
  for (const clockOffset of [-15.625, 15.625]) {
    const ses = session();
    const originalSet = ses.cookies.set;
    ses.cookies.set = details => originalSet({ ...details,
      expirationDate: (coarseNow + clockOffset) / 1000 + 400 * 86400 });
    assert.equal((await restoreCookies(ses, [requested])).installed, 1);
  }
});

test("clock quantization cannot excuse ordinary expiry changes or caps outside one tick", async t => {
  const coarseNow = 1_800_000_000_000;
  t.mock.method(Date, "now", () => coarseNow);
  for (const [requestedDays, actualExpiry] of [
    [30, coarseNow / 1000 + 30 * 86400 - 0.015625],
    [3 * 365, (coarseNow + 18) / 1000 + 400 * 86400],
    [3 * 365, (coarseNow - 18) / 1000 + 400 * 86400],
  ]) {
    const ses = session();
    const originalSet = ses.cookies.set;
    ses.cookies.set = details => originalSet({ ...details, expirationDate: actualExpiry });
    await assert.rejects(restoreCookies(ses, [{ ...cookie("persistent"), session: false,
      expirationDate: coarseNow / 1000 + requestedDays * 86400 }]), { code: "COOKIE_RESTORE_FAILED" });
    assert.equal((await ses.cookies.get({})).length, 0);
  }
});

test("expiry normalization cannot excuse arbitrary expiry or security and scope changes", async () => {
  const requested = { ...cookie("persistent"), session: false,
    expirationDate: Math.floor(Date.now() / 1000) + 3 * 365 * 86400 + 0.1234567 };
  for (const mutate of [
    entry => ({ ...entry, expirationDate: entry.expirationDate - 60 }),
    entry => ({ ...entry, expirationDate: Date.now() / 1000 + 400 * 86400 - 60 }),
    entry => ({ ...entry, expirationDate: Date.now() / 1000 + 3 * 3600 }), // HTTPS cannot use the HTTP cap.
    entry => ({ ...entry, expirationDate: undefined }),
    entry => ({ ...entry, expirationDate: entry.expirationDate + 60 }),
    entry => ({ ...entry, expirationDate: Date.now() / 1000 + 400 * 86400, httpOnly: false }),
    entry => ({ ...entry, expirationDate: Date.now() / 1000 + 400 * 86400, secure: false }),
    entry => ({ ...entry, expirationDate: Date.now() / 1000 + 400 * 86400, domain: ".localhost" }),
    entry => ({ ...entry, expirationDate: Date.now() / 1000 + 400 * 86400, path: "/other" }),
    entry => ({ ...entry, expirationDate: Date.now() / 1000 + 400 * 86400, value: "different" }),
  ]) {
    const original = { ...cookie("original"), name: "original" };
    const ses = session([original]);
    const originalSet = ses.cookies.set;
    ses.cookies.set = details => originalSet(details.name === requested.name ? mutate(details) : details);
    await assert.rejects(restoreCookies(ses, [requested]), { code: "COOKIE_RESTORE_FAILED" });
    const actual = await ses.cookies.get({});
    assert.equal(actual.length, 1);
    assert.equal(actual[0].value, original.value);
  }
});

test("a previously capped native expiry is not treated as an identical unmodified source", async () => {
  const requested = { ...cookie("persistent"), session: false, expirationDate: Date.now() / 1000 + 3 * 365 * 86400 };
  const ses = session([{ ...requested, expirationDate: Date.now() / 1000 + 400 * 86400 }]);
  await restoreCookies(ses, [requested]);
  assert.equal(ses.writes.length, 1, "the no-op comparison has no authority to accept a lifetime cap");
  assert.equal((await ses.cookies.get({}))[0].expirationDate, requested.expirationDate);
});

test("rollback verifies native expiry conversion without losing the original persistent cookie", async () => {
  const original = { ...cookie("original"), name: "original", session: false,
    expirationDate: Date.now() / 1000 + 3 * 365 * 86400 };
  const ses = session([original]);
  const originalSet = ses.cookies.set;
  ses.cookies.set = details => {
    if (details.name !== original.name) throw new Error("synthetic rejection");
    return originalSet({ ...details, expirationDate: Date.now() / 1000 + 400 * 86400 });
  };
  await assert.rejects(restoreCookies(ses, [cookie("replacement")]), { code: "COOKIE_RESTORE_FAILED" });
  const actual = await ses.cookies.get({});
  assert.equal(actual.length, 1);
  assert.equal(actual[0].value, original.value);
  assert.equal(actual[0].session, false);
});

test("failed cookie restore does not overwrite the encrypted snapshot", async () => {
  let writes = 0;
  const store = { read: async () => null, write: async () => { writes += 1; } };
  const ses = session();
  ses.cookies.set = async () => { throw new Error("Chromium rejected cookie"); };
  await assert.rejects(initializeCookies(ses, store, {
    profileId: ID, cookies: JSON.stringify([cookie("preserve")]), cookiesUpdatedAt: NEW,
  }), { code: "COOKIE_RESTORE_FAILED" });
  assert.equal(writes, 0);
});

test("a resolved set call without a retained cookie cannot erase the snapshot", async () => {
  let writes = 0;
  const store = { read: async () => null, write: async () => { writes += 1; } };
  const ses = session();
  ses.cookies.set = async () => {};
  await assert.rejects(initializeCookies(ses, store, {
    profileId: ID, cookies: JSON.stringify([cookie("preserve")]), cookiesUpdatedAt: NEW,
  }), { code: "COOKIE_RESTORE_FAILED" });
  assert.equal(writes, 0);
});

test("expired cloud cookies are reported and never silently replaced by an empty snapshot", async () => {
  let writes = 0;
  const store = { read: async () => null, write: async () => { writes += 1; } };
  await assert.rejects(initializeCookies(session(), store, {
    profileId: ID, cookies: JSON.stringify([{ ...cookie("expired"), session: false, expirationDate: 100 }]), cookiesUpdatedAt: NEW,
  }), { code: "COOKIE_RESTORE_FAILED" });
  assert.equal(writes, 0);
});

test("partial auth-cookie loss never replaces the recoverable checkpoint", async () => {
  for (const failure of ["reject", "drop", "attribute-change"]) {
    const original = { ...cookie("native-auth"), name: "native" };
    const selected = [{ ...cookie("auth"), name: "auth" }, { ...cookie("preference"), name: "preference" }];
    const local = { cookies: selected, cookiesUpdatedAt: NEW, pending: true, baseRevision: OLD };
    let writes = 0;
    const store = { read: async () => local, write: async () => { writes++; } };
    const ses = session([original]);
    const set = ses.cookies.set;
    ses.cookies.set = async details => {
      if (details.name === "auth") {
        if (failure === "reject") throw new Error("synthetic-cookie-value-must-not-leak");
        if (failure === "drop") return;
        return set({ ...details, httpOnly: false });
      }
      return set(details);
    };
    await assert.rejects(initializeCookies(ses, store, {
      profileId: ID, cookies: "[]", cookiesUpdatedAt: OLD,
    }), error => error.code === "COOKIE_RESTORE_FAILED" && !error.message.includes("synthetic-cookie-value"));
    assert.equal(writes, 0);
    assert.equal(local.cookies, selected);
    const restored = await ses.cookies.get({});
    assert.equal(restored.length, 1);
    assert.equal(restored[0].value, original.value);
    assert.equal(restored[0].httpOnly, true);
  }
});

test("expired cookies are skipped without treating valid active cookies as a partial restore", async () => {
  const ses = session([cookie("old-session")]);
  const result = await restoreCookies(ses, [
    { ...cookie("expired"), session: false, expirationDate: 100 },
    { ...cookie("active"), name: "active" },
  ]);
  assert.deepEqual(result, { restored: 1, skipped: 1, expired: 1, installed: 1 });
  assert.equal((await ses.cookies.get({}))[0].value, "active");
});

test("an unreadable native jar and an entirely expired source cannot clear native cookies", async () => {
  for (const unreadable of [true, false]) {
    const ses = session([cookie("original")]);
    let cleared = 0;
    ses.clearStorageData = async () => { cleared++; };
    if (unreadable) ses.cookies.get = async () => { throw new Error("read failed"); };
    const target = unreadable ? [cookie("new")] : [{ ...cookie("expired"), session: false, expirationDate: 100 }];
    await assert.rejects(restoreCookies(ses, target));
    assert.equal(cleared, 0);
  }
});

test("native-only recovery persists the existing jar without clearing its only copy", async () => {
  const ses = session([cookie("native-only-session")]);
  let clears = 0, saved;
  ses.clearStorageData = async () => { clears++; };
  ses.cookies.set = async () => { throw new Error("must not reinstall the only copy"); };
  const result = await initializeCookies(ses, {
    read: async () => null,
    write: async (_id, cookies) => { saved = cookies; },
  }, { profileId: ID, cookies: "[]", cookiesUpdatedAt: null });
  assert.equal(result.source, "native-disk");
  assert.equal(clears, 0);
  assert.equal(saved[0].value, "native-only-session");
  assert.equal((await ses.cookies.get({}))[0].value, "native-only-session");
});

test("unavailable rollback fails closed without committing a partial checkpoint", async () => {
  const local = { cookies: [cookie("full-checkpoint")], cookiesUpdatedAt: NEW, pending: true, baseRevision: OLD };
  const ses = session([cookie("native-original")]);
  let writes = 0;
  ses.cookies.set = async () => { throw Object.assign(new Error("synthetic-sensitive-message"), { code: "COOKIE_TRANSPORT_UNAVAILABLE" }); };
  await assert.rejects(initializeCookies(ses, { read: async () => local, write: async () => { writes++; } }, {
    profileId: ID, cookies: "[]", cookiesUpdatedAt: OLD,
  }), error => error.code === "COOKIE_RESTORE_ROLLBACK_FAILED" && !error.message.includes("synthetic-sensitive-message"));
  assert.equal(writes, 0);
  assert.equal(local.cookies[0].value, "full-checkpoint");
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
