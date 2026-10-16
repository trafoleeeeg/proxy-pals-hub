const test = require("node:test");
const assert = require("node:assert/strict");
const { assertNoPendingProfileClosure, acknowledgeSavedClosure } = require("../runtime/profile-launch-guard.cjs");
test("unacknowledged native closure blocks its profile, not unrelated profiles", () => {
  const outbox = { list: () => [{ profileId: "pending-profile" }] };
  assert.throws(() => assertNoPendingProfileClosure(outbox, "pending-profile"), /предыдущую сессию/);
  assert.doesNotThrow(() => assertNoPendingProfileClosure(outbox, "another-profile"));
  assert.doesNotThrow(() => assertNoPendingProfileClosure({ list: () => [] }, "pending-profile"));
});
test("a successful close acknowledgement keeps launch blocked until the exact checkpoint is durable", async () => {
  const entry = { snapshotId: "snapshot", profileId: "profile", cookies: "[]", cookiesUpdatedAt: "2026-10-16T00:00:00.000Z" };
  let entries = [entry], finish;
  const saved = new Promise(resolve => { finish = resolve; });
  const outbox = { list: () => entries, acknowledge: () => { entries = []; } };
  const task = acknowledgeSavedClosure({ outbox, isRunning: () => false,
    cookieStore: { acknowledgeClosed: async (...args) => {
      assert.deepEqual(args, [entry.profileId, entry.cookies, entry.cookiesUpdatedAt]);
      await saved;
    } },
  }, entry.snapshotId);
  assert.throws(() => assertNoPendingProfileClosure(outbox, entry.profileId));
  finish(); await task;
  assert.doesNotThrow(() => assertNoPendingProfileClosure(outbox, entry.profileId));
});
test("failed, racing or repeated close acknowledgements cannot clean an active session or lose the outbox", async () => {
  let removed = false, writes = 0;
  const outbox = { list: () => removed ? [] : [{ snapshotId: "s", profileId: "p", cookies: "[]", cookiesUpdatedAt: "revision" }], acknowledge: () => { removed = true; } };
  const cookieStore = { acknowledgeClosed: async () => { writes++; throw new Error("synthetic storage failure"); } };
  await assert.rejects(acknowledgeSavedClosure({ outbox, cookieStore, isRunning: () => true }, "s"));
  assert.equal(writes, 0); assert.equal(removed, false);
  await assert.rejects(acknowledgeSavedClosure({ outbox, cookieStore, isRunning: () => false }, "s"));
  assert.equal(writes, 1); assert.equal(removed, false);
  cookieStore.acknowledgeClosed = async () => { writes++; return false; };
  await acknowledgeSavedClosure({ outbox, cookieStore, isRunning: () => false }, "s");
  assert.equal(removed, true);
  await acknowledgeSavedClosure({ outbox, cookieStore, isRunning: () => false }, "s");
  assert.equal(writes, 2, "idempotent acknowledgement does not touch a newer checkpoint");
});
test("unknown native queue cannot be interpreted as empty or expose an error payload", () => {
  for (const outbox of [{ list: () => { throw new Error("synthetic-secret"); } }, { list: () => null }]) {
    assert.throws(() => assertNoPendingProfileClosure(outbox, "profile"), error => {
      assert.match(error.message, /очередь сохранения cookies/);
      assert.doesNotMatch(error.message, /synthetic-secret/);
      return true;
    });
  }
});

test("duplicate close ACKs are single-flight so no stale write can outlive the launch gate", async () => {
  const entry = { snapshotId: "snapshot", profileId: "profile", cookies: "[]", cookiesUpdatedAt: "2026-10-16T00:00:00.000Z" };
  let entries = [entry], writes = 0, finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const outbox = { list: () => entries, acknowledge: () => { entries = []; } };
  const dependencies = { outbox, isRunning: () => false,
    cookieStore: { acknowledgeClosed: async () => { writes++; await waiting; } } };
  const first = acknowledgeSavedClosure(dependencies, entry.snapshotId);
  const duplicate = acknowledgeSavedClosure(dependencies, entry.snapshotId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1, "two IPC retries must share one read/modify/write");
  // A concurrent terminal/archive action may remove the durable record, but
  // startup must still wait until the older checkpoint write is finished.
  entries = [];
  assert.throws(() => assertNoPendingProfileClosure(outbox, entry.profileId));
  finish();
  await Promise.all([first, duplicate]);
  assert.equal(writes, 1);
  assert.doesNotThrow(() => assertNoPendingProfileClosure(outbox, entry.profileId));
});

test("distinct ACKs of one profile serialize and keep the launch gate until the last write", async () => {
  let entries = ["one", "two"].map(snapshotId => ({ snapshotId, profileId: "profile", cookies: "[]", cookiesUpdatedAt: "2026-10-16T00:00:00.000Z" }));
  const outbox = { list: () => entries, acknowledge: id => { entries = entries.filter(entry => entry.snapshotId !== id); } };
  const releases = [];
  const dependencies = { outbox, isRunning: () => false,
    cookieStore: { acknowledgeClosed: () => new Promise(resolve => releases.push(resolve)) } };
  const first = acknowledgeSavedClosure(dependencies, "one");
  const second = acknowledgeSavedClosure(dependencies, "two");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases[0](); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  entries = [];
  assert.throws(() => assertNoPendingProfileClosure(outbox, "profile"));
  releases[1](); await second;
  assert.doesNotThrow(() => assertNoPendingProfileClosure(outbox, "profile"));
});
