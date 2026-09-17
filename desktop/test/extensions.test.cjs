const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createExtensionStore } = require("../extensions.cjs");

test("extension store validates manifests, copies entries and loads them into sessions", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-extensions-"));
  const source = path.join(temp, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Test extension", version: "1.2.3" }));
  const store = createExtensionStore(() => path.join(temp, "user-data"));
  const added = await store.addFromDirectory(source);
  assert.equal(added.name, "Test extension");
  assert.deepEqual(await store.list(), [added]);
  const loaded = [];
  const session = { loadExtension: async (extensionPath) => { loaded.push(extensionPath); return { id: "chrome-test" }; } };
  const loadedState = await store.loadIntoSession(session, new Map());
  assert.equal(loadedState.loaded.length, 1);
  assert.equal(loaded.length, 1);
  await store.remove(added.id);
  assert.deepEqual(await store.list(), []);
  await fs.rm(temp, { recursive: true, force: true });
});

test("extension store rejects non-extension folders", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-extensions-"));
  const store = createExtensionStore(() => path.join(temp, "user-data"));
  await assert.rejects(store.addFromDirectory(temp), /manifest\.json/);
  await fs.rm(temp, { recursive: true, force: true });
});

test("managed paths ignore registry path injection and reject linked source directories", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-extensions-"));
  try {
    const source = path.join(temp, "source");
    const outside = path.join(temp, "outside");
    const data = path.join(temp, "user-data");
    await fs.mkdir(source); await fs.mkdir(outside);
    await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Test", version: "1.0" }));
    await fs.writeFile(path.join(outside, "keep.txt"), "must survive");
    const store = createExtensionStore(() => data);
    const added = await store.addFromDirectory(source);
    await fs.writeFile(path.join(data, "extensions.json"), JSON.stringify([{ id: added.id, path: outside }]));
    const paths = [];
    const loaded = new Map();
    await store.loadIntoSession({ extensions: { loadExtension: async (dir) => { paths.push(dir); return { id: "fixture" }; } } }, loaded);
    assert.equal(paths[0], path.join(data, "extensions", added.id));
    await store.remove(added.id);
    const removed = [];
    await store.loadIntoSession({ extensions: { removeExtension: (id) => removed.push(id) } }, loaded);
    assert.deepEqual(removed, ["fixture"]);
    assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "must survive");
    await fs.symlink(outside, path.join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Linked", version: "2.0" }));
    await assert.rejects(store.addFromDirectory(source), /ссылки/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
