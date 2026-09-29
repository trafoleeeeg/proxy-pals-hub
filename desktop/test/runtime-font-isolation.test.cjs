const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { applyFontIsolation, verifyFontBundle } = require("../runtime/font-isolation.cjs");
const { normalizeFingerprint } = require("../runtime/fingerprint.cjs");

test("font isolation is opt-in and rejects ambiguous values", () => {
  const ua = "Mozilla/5.0 Chrome/152.0.0.0";
  assert.equal(normalizeFingerprint({}, ua).fontIsolation, false);
  assert.equal(normalizeFingerprint({ fontIsolation: true }, ua).fontIsolation, true);
  assert.throws(() => normalizeFingerprint({ fontIsolation: "true" }, ua), /Invalid/);
  assert.throws(() => normalizeFingerprint({ fontIsolation: null }, ua), /Invalid/);
});

test("redistributable font bundle hashes, notices and packaging are pinned", async () => {
  const directory = path.join(__dirname, "../assets/isolated-fonts");
  const files = await verifyFontBundle(directory);
  assert.equal(files.length, 12);
  assert.ok((await fs.readFile(path.join(directory, "LICENSE.txt"), "utf8")).includes("Apache License"));
  assert.ok((await fs.readFile(path.join(directory, "NOTICE.txt"), "utf8")).includes("Google"));
  const config = require("../package.json").build;
  assert.ok(config.files.includes("engine/font-bundle-lock.json"));
  assert.ok(config.extraResources.some(item => item.to === "isolated-fonts" && item.filter.includes("NOTICE.txt")));
});

test("font isolation waits for native completion and cannot change on session reuse", async () => {
  let resolve, calls = 0;
  const gate = new Promise(done => { resolve = done; });
  const ses = { async setUmbraFontIsolation(files) { calls++; assert.equal(files.length, 12); await gate; } };
  const fp = { fontIsolation: true };
  let finished = false;
  const job = applyFontIsolation(ses, fp).then(() => { finished = true; });
  // Bundle verification may still be in progress; neither branch may resolve.
  await new Promise(done => setTimeout(done, 20));
  assert.equal(finished, false);
  resolve(); await job;
  assert.equal(fp.nativeFontIsolation, true);
  await applyFontIsolation(ses, { fontIsolation: true });
  assert.equal(calls, 1);
  await assert.rejects(applyFontIsolation(ses, { fontIsolation: false }), /restart/);
  const ordinary = {};
  await applyFontIsolation(ordinary, { fontIsolation: false });
  await assert.rejects(applyFontIsolation(ordinary, { fontIsolation: true }), /restart/);
});

test("missing native API, missing files and native rejection never downgrade to host fonts", async () => {
  await assert.rejects(applyFontIsolation({}, { fontIsolation: true }), /updated native engine/);
  let calls = 0;
  const missing = { setUmbraFontIsolation() { calls++; } };
  await assert.rejects(applyFontIsolation(missing, { fontIsolation: true },
    { bundleDirectory: path.join(__dirname, "nonexistent-font-bundle") }), /missing or damaged/);
  assert.equal(calls, 0);
  const denied = { async setUmbraFontIsolation() { throw new Error("native failure"); } };
  await assert.rejects(applyFontIsolation(denied, { fontIsolation: true }), /could not be applied/);
  await assert.rejects(applyFontIsolation(denied, { fontIsolation: false }), /restart/);
});

test("same-size corruption is rejected before native parsing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-font-integrity-"));
  try {
    const file = require("../engine/font-bundle-lock.json").files[0].file;
    const bytes = await fs.readFile(path.join(__dirname, "../assets/isolated-fonts", file));
    bytes[0] ^= 1;
    await fs.writeFile(path.join(directory, file), bytes);
    await assert.rejects(verifyFontBundle(directory), /integrity failed/);
    let calls = 0;
    await assert.rejects(applyFontIsolation({ setUmbraFontIsolation() { calls++; } },
      { fontIsolation: true }, { bundleDirectory: directory }), /missing or damaged/);
    assert.equal(calls, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
