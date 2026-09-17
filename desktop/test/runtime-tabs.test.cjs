const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { createTabStore, sanitizeTabs } = require("../runtime/tabs.cjs");

const ID = "11111111-1111-4111-8111-111111111111";
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from("enc:" + value, "utf8"),
  decryptString: (buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
};

test("open tabs survive a profile close and reopen", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-tabs-"));
  const store = createTabStore({ safeStorage, userData });

  assert.deepEqual(await store.read(ID), { tabs: [], activeIndex: 0 });

  await store.write(ID, ["https://a.example/", "https://b.example/", "https://c.example/", "about:blank", "https://d.example/"], 1);
  let saved = await store.read(ID);
  assert.equal(saved.tabs.length, 5);
  assert.equal(saved.activeIndex, 1);

  await store.write(ID, ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"], 0);
  saved = await store.read(ID);
  assert.deepEqual(saved.tabs, ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"]);

  const encrypted = fs.readFileSync(path.join(userData, "profile-tab-snapshots", ID + ".bin"), "utf8");
  assert.ok(encrypted.startsWith("enc:"));
});

test("unsupported and malformed addresses are dropped", () => {
  assert.deepEqual(sanitizeTabs(["javascript:alert(1)", "file:///etc/passwd", "https://ok.example/", 42, null]), ["https://ok.example/"]);
  assert.equal(sanitizeTabs(new Array(80).fill("https://x.example/")).length, 32);
});

test("missing OS encryption keeps tabs out of plain files", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-tabs-plain-"));
  const store = createTabStore({ safeStorage: { isEncryptionAvailable: () => false }, userData });
  await store.write(ID, ["https://a.example/"], 0);
  assert.equal(fs.existsSync(path.join(userData, "profile-tab-snapshots")), false);
  assert.deepEqual(await store.read(ID), { tabs: [], activeIndex: 0 });
});
