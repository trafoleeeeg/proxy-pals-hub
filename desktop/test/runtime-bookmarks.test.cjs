const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { createBookmarkStore, sanitizeBookmarks, MAX_FAVICON_BYTES } = require("../runtime/bookmarks.cjs");

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
    { url: "javascript:alert(1)", title: "Скрипт" },
    { url: "ftp://c.example/", title: "Неподдерживаемая" },
    { url: "https://b.example/" },
  ]);
  assert.equal(saved.length, 3);
  assert.equal(saved[0].title, "Кабинет");
  assert.equal(saved[1].title, "Скрипт");
  assert.equal(saved[2].title, "b.example");

  const reopened = await store.read(ID);
  assert.deepEqual(reopened.map((item) => item.url), ["https://a.example/panel", "javascript:alert(1)", "https://b.example/"]);

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

test("bookmark order and toolbar visibility persist with version-one compatibility", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-bookmarks-state-"));
  const store = createBookmarkStore({ safeStorage, userData });
  const state = await store.write(ID, {
    bookmarks: [{ url: "https://b.example/", title: "Вторая" }, { url: "https://a.example/", title: "Первая" }],
    barVisible: false,
  });
  assert.equal(state.barVisible, false);
  assert.deepEqual((await store.readState(ID)).bookmarks.map((item) => item.title), ["Вторая", "Первая"]);
  assert.equal((await store.readState(ID)).barVisible, false);

  const legacy = JSON.stringify({ version: 1, profileId: ID, bookmarks: [{ url: "https://legacy.example/", title: "Старая" }] });
  fs.writeFileSync(path.join(userData, "profile-bookmarks", `${ID}.bin`), safeStorage.encryptString(legacy));
  const restored = await store.readState(ID);
  assert.equal(restored.barVisible, true);
  assert.deepEqual(restored.bookmarks.map(({ url, title }) => ({ url, title })), [{ url: "https://legacy.example/", title: "Старая" }]);
});

test("bookmarklets survive validation while malformed scripts are dropped", () => {
  const script = "javascript:void(prompt('ok'))";
  const sanitized = sanitizeBookmarks([
    { url: script },
    { url: "javascript:alert(1)\nalert(2)", title: "Многострочный" },
    { url: `javascript:${"x".repeat(200001)}`, title: "Слишком длинный" },
    { url: "JavaScript:alert(1)", title: "С большой буквы" },
  ]);
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].url, script);
  assert.equal(sanitized[0].title, "Скрипт");
  assert.equal(sanitized[1].title, "С большой буквы");
  assert.equal(sanitized[1].url, "JavaScript:alert(1)");
});

test("bookmark favicon persists only for valid size-limited data images", async () => {
  const valid = "data:image/png;base64," + Buffer.from("safe favicon").toString("base64");
  const oversized = "data:image/png;base64," + Buffer.alloc(MAX_FAVICON_BYTES + 1).toString("base64");
  const sanitized = sanitizeBookmarks([
    { url: "https://valid.example/", favicon: valid },
    { url: "https://remote.example/", favicon: "https://remote.example/favicon.ico" },
    { url: "https://svg.example/", favicon: "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64") },
    { url: "https://large.example/", favicon: oversized },
  ]);
  assert.equal(sanitized[0].favicon, valid);
  assert.equal("favicon" in sanitized[1], false);
  assert.equal("favicon" in sanitized[2], false);
  assert.equal("favicon" in sanitized[3], false);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-bookmarks-favicon-"));
  const store = createBookmarkStore({ safeStorage, userData });
  await store.write(ID, { bookmarks: sanitized, barVisible: true });
  assert.equal((await store.read(ID))[0].favicon, valid);
});

test("стартовые закладки валидны и одноразовы", async () => {
  const { defaultBookmarks } = require("../runtime/bookmarks.cjs");
  const seeded = defaultBookmarks();
  assert.deepEqual(seeded.map((item) => item.title), [
    "fb acc", "facebook", "facebook ads", "google ads", "tiktok ads", "tiktok", "gmail почта", "lark bot",
  ]);
  for (const item of seeded.slice(0, -1)) assert.match(item.url, /^https:\/\//);
  const lark = seeded.at(-1);
  assert.ok(lark.url.startsWith("javascript:"));
  assert.ok(lark.url.length > 1000);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-bookmarks-seed-"));
  const store = createBookmarkStore({ safeStorage, userData });
  assert.equal((await store.readState(ID)).stored, false);
  await store.write(ID, { bookmarks: [], barVisible: true });
  const after = await store.readState(ID);
  assert.equal(after.stored, true);
  assert.deepEqual(after.bookmarks, []);
});
