const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ENTRY, MANIFEST, sha256, validateManifest, loadBundled, createPanelBundle } = require("../runtime/panel-bundle.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-public-panel-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundledDirectory = path.join(directory, "bundled");
  const cacheDirectory = path.join(directory, "cache");
  const contents = new Map([[ENTRY, Buffer.from("<html>anonymous v1</html>")], ["/assets/index-test.js", Buffer.from("console.log('v1')")]]);
  const manifest = { schema: 1, entry: ENTRY, minimumDesktopVersion: "0.4.43", revision: "2026-10-06T00:00:00.000Z", files: [...contents].map(([resource, bytes]) => ({ path: resource, size: bytes.length, sha256: sha256(bytes) })) };
  for (const [resource, bytes] of contents) {
    const target = path.join(bundledDirectory, resource.slice(1));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  fs.writeFileSync(path.join(bundledDirectory, MANIFEST.slice(1)), JSON.stringify(manifest));
  const requests = [];
  const panelSession = { protocol: { handle: (_scheme, handler) => { panelSession.handler = handler; } }, fetch: async (input, options) => {
    requests.push({ input, options }); return new Response("server", { status: 200 });
  } };
  const sealed = new Map();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => {
    const id = Buffer.from(String(sealed.size)); sealed.set(id.toString(), value); return id;
  }, decryptString: bytes => { if (!sealed.has(bytes.toString())) throw new Error("unsealed"); return sealed.get(bytes.toString()); } };
  const options = { panelSession, origin: "https://panel.example.test", bundledDirectory, cacheDirectory, safeStorage };
  const originCacheDirectory = path.join(cacheDirectory, sha256(options.origin));
  return { ...options, options, contents, manifest, requests, directory, originCacheDirectory };
}
const documentRequest = route => new Request("https://panel.example.test" + route, { headers: { accept: "text/html" } });

test("only public documents and verified assets are local; API/auth/private POSTs stay live", async t => {
  const f = fixture(t); const panel = createPanelBundle(f.options);
  for (const route of ["/app", "/app/team", "/auth?next=/app"]) assert.equal(await (await panel.handler(documentRequest(route))).text(), "<html>anonymous v1</html>");
  assert.equal(f.requests.length, 0);
  const rpc = new Request("https://panel.example.test/_serverFn/test", { method: "POST", body: "fixture" });
  Object.defineProperty(rpc, "initiatorOrigin", { value: "https://panel.example.test" });
  for (const request of [rpc, new Request("https://auth.example.test/user"), new Request("https://panel.example.test/api/private")]) await panel.handler(request);
  assert.equal(f.requests.length, 3);
  assert(f.requests.every(item => item.options.bypassCustomProtocolHandlers));
  assert.equal(await f.requests[0].input.text(), "fixture");
  assert.equal((await panel.handler(new Request("https://panel.example.test/assets/missing.js"))).status, 404);
});

test("RPC forwarding restores missing CSRF metadata without upgrading untrusted initiators", async t => {
  const f = fixture(t); const panel = createPanelBundle(f.options);
  const make = (referrer, initiator) => {
    const request = new Request("https://panel.example.test/_serverFn/test", { method: "POST", body: "fixture-body", referrer,
      headers: { Authorization: "Bearer fixture-token", "x-tsr-serverFn": "true" } });
    if (initiator !== undefined) Object.defineProperty(request, "initiatorOrigin", { value: initiator });
    return request;
  };
  for (const request of [make("", "https://panel.example.test"), make("https://panel.example.test/app", "https://panel.example.test")]) {
    assert.equal((await panel.handler(request)).status, 200);
    const forwarded = f.requests.at(-1);
    assert.equal(forwarded.options.headers.get("Origin"), "https://panel.example.test");
    assert.equal(forwarded.options.headers.get("Sec-Fetch-Site"), "same-origin");
    assert.equal(forwarded.options.headers.get("Authorization"), "Bearer fixture-token");
    assert.equal(await forwarded.input.text(), "fixture-body");
  }
  const before = f.requests.length;
  for (const request of [make(""), make("https://panel.example.test/app"), make("https://evil.test/page"), make("https://panel.example.test/app", "null"), make("https://panel.example.test/app", "https://evil.test")]) {
    assert.equal((await panel.handler(request)).status, 403);
  }
  assert.equal(f.requests.length, before, "Untrusted RPC never reaches the network");
  const contradictory = make("", "https://panel.example.test");
  contradictory.headers.set("Origin", "https://evil.test");
  contradictory.headers.set("Sec-Fetch-Site", "cross-site");
  await panel.handler(contradictory);
  assert.equal(f.requests.at(-1).options.headers.get("Origin"), "https://evil.test");
  assert.equal(f.requests.at(-1).options.headers.get("Sec-Fetch-Site"), "cross-site");
});

test("rejects traversal, external URLs, duplicates, oversize manifests and rollback", t => {
  const f = fixture(t);
  for (const resource of ["/assets/../../main.cjs", "https://evil.test/code.js", "/assets/%2e%2e/code.js", "/_serverFn/private", "/assets/secret.map"]) {
    assert.throws(() => validateManifest({ ...f.manifest, files: [...f.manifest.files, { path: resource, size: 1, sha256: "a".repeat(64) }] }));
  }
  assert.throws(() => validateManifest({ ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] }));
  assert.throws(() => validateManifest({ ...f.manifest, files: f.manifest.files.map(file => ({ ...file, size: 30 * 1024 * 1024 })) }));
  assert.throws(() => validateManifest(f.manifest, "2027-01-01T00:00:00.000Z"));
  assert.throws(() => validateManifest({ ...f.manifest, minimumDesktopVersion: "0.4.99" }, "", "0.4.43"));
  fs.writeFileSync(path.join(f.bundledDirectory, "assets/index-test.js"), "tampered");
  assert.throws(() => loadBundled(f.bundledDirectory));
});

function remote(f, corrupt = false, revision = "2026-10-07T00:00:00.000Z") {
  const next = { ...f.manifest, revision };
  f.panelSession.fetch = async (input, options) => {
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    const resource = new URL(input).pathname;
    return new Response(resource === MANIFEST ? JSON.stringify(next) : corrupt ? "corrupt" : f.contents.get(resource));
  };
  return next;
}

test("a complete background update is sealed and activated only on next process start", async t => {
  const f = fixture(t); const panel = createPanelBundle(f.options); const next = remote(f);
  const first = panel.update(); assert.equal(panel.update(), first);
  assert.equal(await first, true);
  assert.equal(panel.revision, f.manifest.revision);
  assert.equal(createPanelBundle(f.options).revision, next.revision);
  const pointer = path.join(f.originCacheDirectory, "active.enc");
  fs.writeFileSync(pointer, "untrusted plaintext manifest");
  assert.equal(createPanelBundle(f.options).revision, f.manifest.revision);
});

test("interrupted/corrupt updates and unavailable OS protection keep the bundled UI usable", async t => {
  const f = fixture(t); const panel = createPanelBundle(f.options); remote(f, true);
  assert.equal(await panel.update(), false);
  assert.equal(createPanelBundle(f.options).revision, f.manifest.revision);
  assert.equal(fs.existsSync(path.join(f.originCacheDirectory, "active.enc")), false);
  f.options.safeStorage.isEncryptionAvailable = () => false;
  assert.equal(await createPanelBundle(f.options).update(), false);
});

test("tampering with one cached chunk rejects the entire generation", async t => {
  const f = fixture(t); const panel = createPanelBundle(f.options); remote(f);
  assert.equal(await panel.update(), true);
  const generation = fs.readdirSync(f.originCacheDirectory).find(name => name.length === 36);
  fs.writeFileSync(path.join(f.originCacheDirectory, generation, "assets/index-test.js"), "tampered");
  assert.equal(createPanelBundle(f.options).revision, f.manifest.revision);
});

test("each exact origin has an independent cache and revision lineage", async t => {
  const f = fixture(t);
  const oldOrigin = "https://proxy-pals-hub.lovable.app";
  const oldDirectory = path.join(f.cacheDirectory, sha256(oldOrigin));
  const old = createPanelBundle({ ...f.options, origin: oldOrigin });
  remote(f, false, "2099-01-01T00:00:00.000Z");
  assert.equal(await old.update(), true);
  assert.equal(createPanelBundle({ ...f.options, origin: oldOrigin }).revision, "2099-01-01T00:00:00.000Z");
  const next = createPanelBundle(f.options);
  assert.equal(next.revision, f.manifest.revision, "Old origin cannot raise the new origin's minimum revision");
  remote(f);
  assert.equal(await next.update(), true);
  assert.equal(createPanelBundle(f.options).revision, "2026-10-07T00:00:00.000Z");
  assert(fs.existsSync(path.join(oldDirectory, "active.enc")), "Rollback cache is retained, not deleted");
});

test("foreign-origin or legacy sealed pointers cannot activate copied code", async t => {
  const f = fixture(t); const panel = createPanelBundle(f.options); remote(f);
  assert.equal(await panel.update(), true);
  const pointer = path.join(f.originCacheDirectory, "active.enc");
  const metadata = JSON.parse(f.safeStorage.decryptString(fs.readFileSync(pointer)));
  assert.equal(metadata.schema, 2);
  assert.equal(metadata.origin, f.origin);
  assert.equal(createPanelBundle(f.options).revision, metadata.manifest.revision, "Valid generation exists for this negative test");
  for (const changed of [
    { ...metadata, origin: "https://proxy-pals-hub.lovable.app" },
    { generation: metadata.generation, manifest: metadata.manifest },
    { ...metadata, schema: 1 },
  ]) {
    fs.writeFileSync(pointer, f.safeStorage.encryptString(JSON.stringify(changed)));
    assert.equal(createPanelBundle(f.options).revision, f.manifest.revision);
  }
});

test("unscoped legacy pointers and high revisions are preserved but never imported", async t => {
  const f = fixture(t); const panel = createPanelBundle(f.options);
  remote(f, false, "2099-01-01T00:00:00.000Z"); assert.equal(await panel.update(), true);
  const scopedPointer = path.join(f.originCacheDirectory, "active.enc");
  const metadata = JSON.parse(f.safeStorage.decryptString(fs.readFileSync(scopedPointer)));
  fs.cpSync(path.join(f.originCacheDirectory, metadata.generation), path.join(f.cacheDirectory, metadata.generation), { recursive: true });
  const legacy = f.safeStorage.encryptString(JSON.stringify({ generation: metadata.generation, manifest: metadata.manifest }));
  const legacyPointer = path.join(f.cacheDirectory, "active.enc");
  fs.writeFileSync(legacyPointer, legacy); fs.unlinkSync(scopedPointer);
  assert.equal(createPanelBundle(f.options).revision, f.manifest.revision);
  assert.deepEqual(fs.readFileSync(legacyPointer), legacy, "No deletion of the previous origin's rollback cache");
});

test("panel bundle rejects non-canonical or credential-bearing origins", t => {
  const f = fixture(t);
  for (const origin of ["http://panel.example.test", "https://panel.example.test/", "https://panel.example.test/app", "https://user:pass@panel.example.test", "https://panel.example.test?query", "https://panel.example.test#hash"]) {
    assert.throws(() => createPanelBundle({ ...f.options, origin }));
  }
});
