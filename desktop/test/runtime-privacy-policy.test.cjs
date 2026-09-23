const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createPrivacyStore, privacyOrigin } = require("../runtime/privacy-policy.cjs");
const { normalizeFingerprint, installSessionPrivacy } = require("../runtime/fingerprint.cjs");
const ID = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value.split("").reverse().join("")), decryptString: (value) => value.toString().split("").reverse().join("") };

test("privacy exceptions persist locally, bind to profile and default to deny on corrupt storage", async (t) => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-privacy-policy-"));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const store = createPrivacyStore({ userData, safeStorage });
  assert.deepEqual(await store.read(ID), []);
  await store.write(ID, ["https://site.test"]);
  assert.deepEqual(await createPrivacyStore({ userData, safeStorage }).read(ID), ["https://site.test"]);
  assert.deepEqual(await store.read(OTHER), []);
  const target = path.join(userData, "profile-privacy", ID + ".bin");
  const data = await fs.readFile(target);
  assert.equal(data.includes(Buffer.from("https://site.test")), false);
  await fs.copyFile(target, path.join(userData, "profile-privacy", OTHER + ".bin"));
  assert.deepEqual(await store.read(OTHER), []);
  await fs.writeFile(target, "corrupt fixture");
  assert.deepEqual(await store.read(ID), []);
  await assert.rejects(store.write(ID, ["https://site.test/path"]), /Некорректное/);
  await assert.rejects(createPrivacyStore({ userData, safeStorage: { ...safeStorage, getSelectedStorageBackend: () => "basic_text" } }).write(ID, []), /зашифровать/);
});

test("privacy origin disallows credentials and non-web schemes and retains port", () => {
  assert.equal(privacyOrigin("https://site.test/path?a=1"), "https://site.test");
  assert.equal(privacyOrigin("https://site.test:9443/"), "https://site.test:9443");
  for (const value of ["https://user:password@site.test", "file:///tmp", "data:text/html,hi", "blob:https://site.test/id", "invalid"]) assert.equal(privacyOrigin(value), "");
});

test("session header guard removes host hints and rejects unapproved service workers", () => {
  let listener;
  const ses = { webRequest: { onBeforeSendHeaders: (handler) => { listener = handler; } } };
  const fp = normalizeFingerprint({ os: "macos", languages: ["de-DE", "de"], userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/152.0.0.0" });
  fp.hardwareOrigins = ["https://allowed.test"];
  installSessionPrivacy(ses, fp);
  let response;
  const request = (url, requestHeaders) => { listener({ url, requestHeaders }, (result) => { response = result; }); return response; };
  assert.deepEqual(request("https://blocked.test/sw.js", { "Service-Worker": "script" }), { cancel: true });
  const allowed = request("https://allowed.test/sw.js", { "Service-Worker": "script", "user-agent": "Host Electron/44", "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-unknown": '"host"', "Accept-Language": "ru" });
  assert.equal(allowed.requestHeaders["User-Agent"], fp.userAgent);
  assert.equal(allowed.requestHeaders["sec-ch-ua-platform"], '"macOS"');
  assert.equal(allowed.requestHeaders["sec-ch-ua-unknown"], undefined);
  assert.match(allowed.requestHeaders["Accept-Language"], /^de-DE/);
  assert.deepEqual(request("https://sub.allowed.test/sw.js", { "service-worker": "script" }), { cancel: true });
});
