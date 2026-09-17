const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { createBookmarkStore, sanitizeBookmarks } = require("../runtime/bookmarks.cjs");

const ID = "11111111-1111-4111-8111-111111111111";
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from("enc:" + value, "utf8"),
  decryptString: (buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
};

test("profile bookmarks persist encrypted and survive a reopen", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-bookmarks-"));
  const store = createBookmarkStore({ safeStorage, userData });

  assert.deepEqual(await store.read(ID), []);

  const saved = await store.write(ID, [
    { url: "https://a.example/panel", title: "Кабинет" },
    { url: "https://a.example/panel", title: "Дубликат" },
    { url: "javascript:alert(1)", title: "Опасная" },
    { url: "https://b.example/" },
  ]);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].title, "Кабинет");
  assert.equal(saved[1].title, "b.example");

  const reopened = await store.read(ID);
  assert.deepEqual(reopened.map((item) => item.url), ["https://a.example/panel", "https://b.example/"]);

  const file = path.join(userData, "profile-bookmarks", `${ID}.bin`);
  assert.ok(fs.readFileSync(file, "utf8").startsWith("enc:"));

  await store.remove(ID);
  assert.deepEqual(await store.read(ID), []);
});

test("bookmarks are capped and skipped without OS encryption", async () => {
  const many = Array.from({ length: 90 }, (_, index) => ({ url: `https://site${index}.example/` }));
  assert.equal(sanitizeBookmarks(many).length, 64);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-bookmarks-plain-"));
  const store = createBookmarkStore({ safeStorage: { isEncryptionAvailable: () => false }, userData });
  await store.write(ID, [{ url: "https://a.example/" }]);
  assert.deepEqual(await store.read(ID), []);
  assert.equal(fs.existsSync(path.join(userData, "profile-bookmarks")), false);
});
