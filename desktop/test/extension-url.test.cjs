const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { unpackArchive, stripCrxHeader } = require("../crx.cjs");
const { parseExtensionUrl } = require("../extension-source.cjs");
const { createExtensionStore } = require("../extensions.cjs");

// Minimal ZIP writer (deflate) so tests do not depend on external tools.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = zlib.deflateRawSync(raw);
    const nameBuffer = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

test("store links are turned into a download address, other links are validated", () => {
  const store = parseExtensionUrl("https://chromewebstore.google.com/detail/name/abcdefghijklmnopabcdefghijklmnop");
  assert.equal(store.kind, "store");
  assert.match(store.downloadUrl, /clients2\.google\.com/);
  assert.equal(parseExtensionUrl("https://example.com/ext.crx").kind, "url");
  assert.throws(() => parseExtensionUrl("http://example.com/ext.crx"), /https/);
  assert.throws(() => parseExtensionUrl("https://chromewebstore.google.com/detail/name"), /идентификатор/);
});

test("crx header is stripped and unsafe paths are rejected", async () => {
  const archive = zip({ "manifest.json": "{}" });
  const crx = Buffer.concat([Buffer.from("Cr24"), header(3, 4), Buffer.from("abcd"), archive]);
  assert.deepEqual(stripCrxHeader(crx), archive);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-crx-"));
  await assert.rejects(unpackArchive(zip({ "../evil.txt": "x" }), target), /небезопасные пути/);
});

function header(version, length) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(version, 0);
  buffer.writeUInt32LE(length, 4);
  return buffer;
}

test("downloaded extension is installed and can be updated from its source", async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-store-"));
  let version = "1.0.0";
  const store = createExtensionStore(() => userData, {
    fetchBuffer: async () => zip({ "manifest.json": JSON.stringify({ name: "Ссылочное", version, manifest_version: 3 }) }),
  });
  const added = await store.addFromUrl("https://example.com/ext.crx");
  assert.equal(added.version, "1.0.0");
  assert.deepEqual(await store.list(), [{ id: added.id, name: "Ссылочное", version: "1.0.0", source: "url", url: "https://example.com/ext.crx" }]);
  version = "2.0.0";
  const updated = await store.update(added.id);
  assert.equal(updated.id, added.id);
  assert.equal(updated.version, "2.0.0");
});
