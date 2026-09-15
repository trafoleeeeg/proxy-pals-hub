const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSessionOutbox } = require("../session-outbox.cjs");
test("unacknowledged snapshots survive restart and an old acknowledgement cannot delete a newer snapshot", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-outbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const protection = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text).map((n) => n ^ 127),
    decryptString: (bytes) => Buffer.from(bytes).map((n) => n ^ 127).toString(),
  };
  const first = createSessionOutbox(dir, protection);
  const old = first.enqueue({ profileId: "12345678-1234-1234-1234-123456789012", cookies: "secret-session" });
  const newer = first.enqueue({ profileId: old.profileId, cookies: "new-session" });
  assert(!fs.readFileSync(path.join(dir, old.snapshotId + ".bin")).includes("secret-session"));
  const second = createSessionOutbox(dir, protection);
  assert.equal(second.list().length, 2);
  second.acknowledge(old.snapshotId);
  assert.deepEqual(second.list().map((p) => p.snapshotId), [newer.snapshotId]);
  assert.throws(() => second.acknowledge("../outside"), /Invalid/);
});
test("outbox never silently stores plaintext when encryption is unavailable", () => {
  const outbox = createSessionOutbox("unused", { isEncryptionAvailable: () => false });
  assert.throws(() => outbox.enqueue({ profileId: "12345678-1234-1234-1234-123456789012" }), /encryption/);
});
test("terminal session archive atomically retires the active encrypted record and allows retries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-outbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const protection = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text).map((n) => n ^ 127),
    decryptString: (bytes) => Buffer.from(bytes).map((n) => n ^ 127).toString(),
  };
  const outbox = createSessionOutbox(dir, protection);
  const entry = outbox.enqueue({ profileId: "12345678-1234-1234-1234-123456789012", cookies: "terminal-secret" });
  const encrypted = fs.readFileSync(path.join(dir, entry.snapshotId + ".bin"));
  outbox.archive(entry.snapshotId);
  assert.deepEqual(outbox.list(), []);
  const archive = path.join(dir, "archived", entry.snapshotId + ".bin");
  assert.deepEqual(fs.readFileSync(archive), encrypted);
  assert(!fs.readFileSync(archive).includes("terminal-secret"));
  outbox.archive(entry.snapshotId);
  assert.throws(() => outbox.archive("23456789-1234-1234-1234-123456789012"), /not found/);
  assert.throws(() => outbox.archive("../outside"), /Invalid/);
});
