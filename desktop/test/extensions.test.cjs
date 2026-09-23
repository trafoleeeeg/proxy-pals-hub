const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createExtensionStore } = require("../extensions.cjs");

test("cloud metadata cannot trigger downloads or installation", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-extension-cloud-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  let downloads = 0;
  const store = createExtensionStore(() => temp, { fetchBuffer: async () => { downloads++; throw new Error("unexpected network"); } });
  await store.applyCloudSettings([{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", url: "https://example.test/fixture.zip", pinned: true }]);
  assert.equal(downloads, 0);
  assert.deepEqual(await store.list(), []);
});

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
  assert.equal((await store.loadIntoSession(session, new Map())).loaded.length, 0, "installation is not consent for every profile");
  const loadedState = await store.loadIntoSession(session, new Map(), [added.id]);
  assert.equal(loadedState.loaded.length, 1);
  assert.equal(loaded.length, 1);
  await store.setPinned(added.id, true);
  assert.equal((await store.list())[0].pinned, true);
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
    await store.loadIntoSession({ extensions: { loadExtension: async (dir) => { paths.push(dir); return { id: "fixture" }; } } }, loaded, [added.id]);
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

test("extension toolbar chooses the icon nearest to 32 px", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-extension-icons-"));
  try {
    const source = path.join(temp, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "Icons", version: "1.0", icons: { 16: "16.png", 32: "32.png", 128: "128.png" },
    }));
    await Promise.all([16, 32, 128].map((size) => fs.writeFile(path.join(source, `${size}.png`), Buffer.from(`icon-${size}`))));
    const store = createExtensionStore(() => path.join(temp, "user-data"));
    await store.addFromDirectory(source);
    assert.equal((await store.list())[0].icon, `data:image/png;base64,${Buffer.from("icon-32").toString("base64")}`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
