const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createCookieRecovery, recoveryRequest } = require("../runtime/cookie-recovery.cjs");
const { initializeCookies, canonicalCookies } = require("../runtime/cookies.cjs");
const ID = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const OLD = "2026-01-01T00:00:00.000Z", NEW = "2026-02-01T00:00:00.000Z";
const cookie = value => ({ name: "session", value, domain: "example.test", path: "/", session: true, hostOnly: true, secure: true });
const local = () => ({ cookies: [cookie("synthetic-local-secret")], cookiesUpdatedAt: NEW, pending: true, baseRevision: OLD });
const cloud = () => ({ cookies: [cookie("synthetic-cloud-secret")], cookiesUpdatedAt: NEW });
const payload = () => ({ profileId: ID, name: "Test", lockToken: "synthetic-lease", cookies: JSON.stringify(cloud().cookies), cookiesUpdatedAt: NEW });
async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-cookie-recovery-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    },
  };
  let clock = Date.parse("2026-10-10T00:00:00Z");
  const recovery = createCookieRecovery({ safeStorage, userData: directory, now: () => clock });
  return { directory, recovery, safeStorage, advance: ms => { clock += ms; } };
}
async function receipt(recovery, p = payload(), l = local(), c = cloud()) {
  try { await recovery.select(p, l, c); assert.fail("conflict expected"); }
  catch (error) { assert.equal(error.code, "COOKIE_RECOVERY_CONFLICT"); return error.recovery; }
}

test("explicit local recovery durably encrypts BOTH versions and supports cloud rollback", async t => {
  const h = await harness(t), selected = await receipt(h.recovery);
  assert.equal(JSON.stringify(selected).includes("synthetic-"), false);
  const restored = await h.recovery.select({ ...payload(), cookieRecovery: { source: "local", receiptId: selected.receiptId } }, local(), cloud());
  assert.deepEqual(restored.cookies, local().cookies);
  assert.equal(restored.source, "local-recovery-selected");
  const files = await fs.readdir(path.join(h.directory, "profile-cookie-recovery", ID));
  assert.equal(files.length, 1);
  const encrypted = await fs.readFile(path.join(h.directory, "profile-cookie-recovery", ID, files[0]));
  assert.equal(encrypted.includes(Buffer.from("synthetic-local-secret")), false);
  assert.equal(encrypted.includes(Buffer.from("synthetic-cloud-secret")), false);
  const archived = JSON.parse(h.safeStorage.decryptString(encrypted));
  assert.equal(canonicalCookies(archived.local.cookies), canonicalCookies(local().cookies));
  assert.equal(canonicalCookies(archived.cloud.cookies), canonicalCookies(cloud().cookies));
  const backups = await h.recovery.listBackups(ID);
  assert.equal(backups[0].backupId, restored.backupId);
  assert.equal(JSON.stringify(backups).includes("synthetic-"), false);
  const next = { ...local(), cookies: [cookie("synthetic-newer-edit")] };
  const rollback = await h.recovery.select({ ...payload(), cookieRecovery: { source: "cloud", backupId: restored.backupId } }, next, cloud());
  assert.equal(canonicalCookies(rollback.cookies), canonicalCookies(cloud().cookies));
  assert.equal((await h.recovery.listBackups(ID)).length, 2);
});

test("cloud recovery also preserves local session, including CHIPS ancestor identity", async t => {
  const h = await harness(t), l = local();
  l.cookies[0].partitionKey = { topLevelSite: "https://top.test", hasCrossSiteAncestor: true };
  const selection = await receipt(h.recovery, payload(), l);
  const restored = await h.recovery.select({ ...payload(), cookieRecovery: { source: "cloud", receiptId: selection.receiptId } }, l, cloud());
  assert.deepEqual(restored.cookies, cloud().cookies);
  const rollback = await h.recovery.select({ ...payload(), cookieRecovery: { source: "local", backupId: restored.backupId } }, local(), cloud());
  assert.deepEqual(rollback.cookies[0].partitionKey, l.cookies[0].partitionKey);
});

test("changed content, revision, foreign profile, expired and lost receipts require a NEW choice", async t => {
  for (const change of ["local", "cloud", "revision", "foreign", "expired", "restart"]) {
    const h = await harness(t), selection = await receipt(h.recovery);
    const p = { ...payload(), cookieRecovery: { source: "local", receiptId: selection.receiptId } }, l = local(), c = cloud();
    let recovery = h.recovery;
    if (change === "local") l.cookies[0].value = "synthetic-changed";
    if (change === "cloud") c.cookies[0].value = "synthetic-changed";
    if (change === "revision") c.cookiesUpdatedAt = "2026-03-01T00:00:00Z";
    if (change === "foreign") p.profileId = OTHER;
    if (change === "expired") h.advance(30 * 60 * 1000 + 1);
    if (change === "restart") recovery = createCookieRecovery({ safeStorage: h.safeStorage, userData: h.directory });
    await assert.rejects(recovery.select(p, l, c), error => error.code === "COOKIE_RECOVERY_CONFLICT" && error.recovery.changed && error.recovery.receiptId !== selection.receiptId);
    assert.deepEqual(await recovery.listBackups(p.profileId), []);
  }
});

test("no receipt/source/lease can silently override a checkpoint", async t => {
  const h = await harness(t), selection = await receipt(h.recovery);
  assert.throws(() => recoveryRequest({ source: "local" }), /Invalid/);
  assert.throws(() => recoveryRequest({ source: "local", backupId: "../escape" }), /Invalid/);
  assert.throws(() => recoveryRequest({ source: "cloud", receiptId: selection.receiptId, backupId: selection.receiptId }), /Invalid/);
  await assert.rejects(h.recovery.select({ ...payload(), lockToken: null, cookieRecovery: { source: "local", receiptId: selection.receiptId } }, local(), cloud()), /блокировка/);
  assert.deepEqual(await h.recovery.listBackups(ID), []);
});

test("failed authenticated backup prevents clearing native cookies or replacing the checkpoint", async t => {
  const h = await harness(t), selection = await receipt(h.recovery);
  h.safeStorage.decryptString = () => { throw new Error("synthetic-readback-failure"); };
  let cleared = false, written = false;
  const store = { read: async () => local(), write: async () => { written = true; } };
  const ses = { clearStorageData: async () => { cleared = true; } };
  await assert.rejects(initializeCookies(ses, store, { ...payload(), cookieRecovery: { source: "local", receiptId: selection.receiptId } }, h.recovery), /резерв/);
  assert.equal(cleared, false); assert.equal(written, false);
});

test("unsafe encryption and corrupt or foreign backups cannot start a rollback", async t => {
  const h = await harness(t), selection = await receipt(h.recovery);
  const result = await h.recovery.select({ ...payload(), cookieRecovery: { source: "local", receiptId: selection.receiptId } }, local(), cloud());
  const file = path.join(h.directory, "profile-cookie-recovery", ID, result.backupId + ".bin");
  const bytes = await fs.readFile(file); bytes[30] ^= 0xff; await fs.writeFile(file, bytes);
  await assert.rejects(h.recovery.select({ ...payload(), cookieRecovery: { source: "cloud", backupId: result.backupId } }, local(), cloud()), /резерв/);
  await assert.rejects(h.recovery.select({ ...payload(), profileId: OTHER, cookieRecovery: { source: "cloud", backupId: result.backupId } }, local(), cloud()));
  h.safeStorage.isEncryptionAvailable = () => false;
  await assert.rejects(h.recovery.select({ ...payload(), cookieRecovery: { source: "local", receiptId: selection.receiptId } }, local(), cloud()), /encryption/);
});

test("all retained attributes and expired differences still need explicit consent", async t => {
  const h = await harness(t), l = local(), c = { ...cloud(), cookies: [...local().cookies, { ...cookie("expired"), session: false, expirationDate: 1 }] };
  const selection = await receipt(h.recovery, payload(), l, c);
  assert.equal(selection.local.count, 1); assert.equal(selection.cloud.count, 2);
  assert.equal(selection.local.activeCount, 1); assert.equal(selection.cloud.activeCount, 1);
  const equal = { ...l, cookiesUpdatedAt: NEW };
  assert.equal(await h.recovery.select(payload(), l, equal), null);
});

test("initializeCookies selects the consented local jar and rebases it to the fresh cloud lease", async t => {
  const h = await harness(t), selection = await receipt(h.recovery);
  let jar = [cookie("synthetic-original-native")], checkpoint = local();
  const ses = { clearStorageData: async () => { jar = []; }, cookies: {
    get: async () => jar, flushStore: async () => {},
    set: async details => { jar.push({ ...details, domain: new URL(details.url).hostname, hostOnly: true, session: true }); },
  } };
  const store = { read: async () => checkpoint, write: async (_id, cookies, updatedAt, state) => { checkpoint = { cookies, cookiesUpdatedAt: updatedAt, ...state }; } };
  const restored = await initializeCookies(ses, store, { ...payload(), cookieRecovery: { source: "local", receiptId: selection.receiptId } }, h.recovery);
  assert.equal(jar[0].value, "synthetic-local-secret");
  assert.equal(checkpoint.pending, true); assert.equal(checkpoint.baseRevision, NEW);
  assert.equal(restored.source, "local-recovery-selected");
  assert.equal((await h.recovery.listBackups(ID))[0].backupId, restored.recoveryBackupId);
  assert.ok(Date.parse(checkpoint.cookiesUpdatedAt) > Date.parse(NEW));
});

test("unavailable encryption fails before native or checkpoint mutation", async t => {
  const h = await harness(t), selection = await receipt(h.recovery);
  h.safeStorage.getSelectedStorageBackend = () => "basic_text";
  let cleared = false, written = false;
  await assert.rejects(initializeCookies({ clearStorageData: async () => { cleared = true; } },
    { read: async () => local(), write: async () => { written = true; } },
    { ...payload(), cookieRecovery: { source: "local", receiptId: selection.receiptId } }, h.recovery), /encryption/);
  assert.equal(cleared, false); assert.equal(written, false);
});
