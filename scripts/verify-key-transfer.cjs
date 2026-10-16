// Offline HTTP smoke of the real built TanStack/Pages worker. This script only
// activates a COPY with synthetic keys; source and deployable output stay intact.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { constants, createDecipheriv, createHash, createHmac, generateKeyPairSync, privateDecrypt, randomUUID } = require("node:crypto");
const { toJSON, fromCrossJSON } = require("seroval");

const SOURCE = "https://proxy-pals-hub.lovable.app";
const TARGET = "https://umbra.mafiatrafa.com";
const AUTH_ORIGIN = "https://key-transfer-synthetic.invalid";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SYNTHETIC_MARKER = "SYNTHETIC_KEY_TRANSFER_HTTP_ONLY";
const SYNTHETIC_KEY = `  ${SYNTHETIC_MARKER}\tключ🙂\r\n`;
// Rolldown renders this module-level object with an unindented closing line;
// nested manifest fields have deeper indentation. Match text only, never eval
// the original public manifest. This also supports an approved active window.
const COMPILED_CONFIG = /^var keyTransferConfig = \{\r?\n[\s\S]*?^\};/gm;
const digest = value => createHash("sha256").update(value).digest("hex");

function filesUnder(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), "Fixture must not follow symlinks");
    if (entry.isDirectory()) files.push(...filesUnder(name));
    else { assert(entry.isFile(), "Unexpected fixture entry"); files.push(name); }
  }
  return files;
}

function syntheticJwt(age = 0) {
  const seconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    sub: USER_ID, aud: "authenticated", role: "authenticated", iss: AUTH_ORIGIN + "/auth/v1",
    iat: seconds, exp: seconds + 3600, is_anonymous: false,
    amr: [{ method: "password", timestamp: seconds - age }],
  })).toString("base64url");
  // The Auth fake explicitly accepts these fixture tokens; no live server or
  // real JWT signing key is used. HS256 forces the SDK's getUser fallback.
  return `${header}.${claims}.${createHmac("sha256", "offline-synthetic-signing-key").update(`${header}.${claims}`).digest("base64url")}`;
}

function decryptEnvelope(envelope, pair, request) {
  assert.equal(envelope.format, "umbra-key-transfer-v1");
  assert.equal(envelope.transferId, request.transferId);
  assert.equal(envelope.keyId, request.keyId);
  assert.equal(envelope.sourceOrigin, SOURCE);
  assert.equal(envelope.targetOrigin, TARGET);
  assert.equal(envelope.expiresAt, request.expiresAt);
  assert(Date.parse(envelope.issuedAt) >= Date.parse(request.createdAt));
  assert(Date.parse(envelope.issuedAt) < Date.parse(request.expiresAt));
  const key = privateDecrypt({
    key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256", oaepLabel: Buffer.alloc(0),
  }, Buffer.from(envelope.wrappedKey, "base64"));
  let payloadBytes;
  let plainCanary;
  const derived = createHash("sha256").update(SYNTHETIC_KEY, "utf8").digest();
  try {
    assert.equal(key.length, 32);
    assert.equal(Buffer.from(envelope.iv, "base64").length, 12);
    assert.equal(Buffer.from(envelope.tag, "base64").length, 16);
    const aad = Buffer.from(JSON.stringify([
      envelope.format, envelope.transferId, envelope.keyId, envelope.sourceOrigin,
      envelope.targetOrigin, envelope.issuedAt, envelope.expiresAt,
    ]), "utf8");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    payloadBytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    assert.equal(payload.secretName, "APP_ENCRYPTION_KEY");
    assert(Buffer.from(payload.secret, "utf8").equals(Buffer.from(SYNTHETIC_KEY, "utf8")), "Exact UTF-8 bytes must survive HTTP and envelope transport");
    const [iv, tag, ciphertext] = payload.canary.encrypted.split(".").map(part => Buffer.from(part, "base64"));
    assert.equal(iv.length, 12); assert.equal(tag.length, 16);
    const canary = createDecipheriv("aes-256-gcm", derived, iv);
    canary.setAuthTag(tag);
    plainCanary = Buffer.concat([canary.update(ciphertext), canary.final()]);
    assert(plainCanary.equals(Buffer.from(payload.canary.plain, "utf8")), "Existing secret encryption canary must decrypt byte-for-byte");
  } finally { key.fill(0); derived.fill(0); payloadBytes?.fill(0); plainCanary?.fill(0); }
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const workerDirectory = path.join(root, "dist", "_worker.js");
  const configSource = path.join(root, "src", "lib", "key-transfer-config.server.ts");
  const sourceBytes = fs.readFileSync(configSource);
  assert.match(sourceBytes.toString("utf8"), /export const keyTransferConfig\b/);
  const workerFiles = filesUnder(workerDirectory);
  const before = new Map(workerFiles.map(file => [file, digest(fs.readFileSync(file))]));
  const compiledConfigs = workerFiles.filter(file => /key-transfer\.functions-[^/\\]+\.mjs$/.test(file)).filter(file => {
    const matches = fs.readFileSync(file, "utf8").match(COMPILED_CONFIG);
    assert(!matches || matches.length === 1, "Compiled config must occur exactly once");
    return !!matches;
  });
  assert.equal(compiledConfigs.length, 1, "Expected one module-level compiled transfer config");

  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  const now = Date.now();
  const fixture = {
    format: "umbra-key-transfer-request-v1", transferId: randomUUID(), keyId: digest(spki),
    sourceOrigin: SOURCE, targetOrigin: TARGET,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    publicKeySpki: spki.toString("base64"),
  };
  // A fixture's private key and APP key must never enter client assets.
  for (const file of filesUnder(path.join(root, "dist", "assets"))) {
    const bytes = fs.readFileSync(file);
    assert(!bytes.includes(Buffer.from(SYNTHETIC_MARKER)) && !bytes.includes(Buffer.from(privatePem)) && !bytes.includes(Buffer.from("-----BEGIN PRIVATE KEY-----")), "Public assets must not contain secret material");
  }

  const tempParent = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(tempParent, "umbra-key-transfer-http-"));
  const copy = path.join(temporary, "worker");
  const previousFetch = globalThis.fetch;
  const previousConsole = { error: console.error, warn: console.warn, log: console.log };
  const consoleOutput = [];
  let forbiddenRequests = 0;
  let upstreamCalls = 0;
  let httpChecks = 0;
  const freshJwt = syntheticJwt();
  const staleJwt = syntheticJwt(601);
  const validTokens = new Set([freshJwt, staleJwt]);
  const state = { role: true, roleError: false, userId: USER_ID, anonymous: false, authError: false };
  try {
    fs.cpSync(workerDirectory, copy, { recursive: true, errorOnExist: true, force: false });
    const copiedConfig = path.join(copy, path.relative(workerDirectory, compiledConfigs[0]));
    const compiled = fs.readFileSync(copiedConfig, "utf8");
    assert.equal((compiled.match(COMPILED_CONFIG) || []).length, 1);
    // The only modified file is beneath this script's new temporary directory.
    fs.writeFileSync(copiedConfig, compiled.replace(COMPILED_CONFIG, `var keyTransferConfig = ${JSON.stringify({ enabled: true, request: fixture })};`));
    process.env.SUPABASE_URL = AUTH_ORIGIN;
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_synthetic_http_not_real";
    process.env.APP_ENCRYPTION_KEY = SYNTHETIC_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    for (const name of Object.keys(previousConsole)) console[name] = (...args) => {
      consoleOutput.push(args.map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(" "));
    };
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      if (url.origin !== AUTH_ORIGIN || !validTokens.has(authorization?.replace(/^Bearer /, ""))) {
        forbiddenRequests++;
        throw new Error("Offline HTTP fixture refused an unexpected upstream request");
      }
      upstreamCalls++;
      if (request.method === "GET" && url.pathname === "/auth/v1/user" && !url.search) {
        if (state.authError) return Response.json({ message: "synthetic auth refusal" }, { status: 401 });
        return Response.json({ id: state.userId, aud: "authenticated", role: "authenticated", is_anonymous: state.anonymous,
          app_metadata: {}, user_metadata: {}, identities: [], created_at: "2026-01-01T00:00:00.000Z" });
      }
      if (request.method === "POST" && url.pathname === "/rest/v1/rpc/is_superadmin" && !url.search) {
        assert.deepEqual(await request.json(), {}, "Role check must not read user data or select a supplied identity");
        return state.roleError ? Response.json({ code: "SYNTHETIC", message: "synthetic role refusal" }, { status: 403 }) : Response.json(state.role);
      }
      forbiddenRequests++;
      throw new Error("Offline HTTP fixture refused an unexpected upstream path");
    };
    const { defaultSerovalDeserializerPlugins } = await import("@tanstack/router-core/ssr/client");
    const { default: worker } = await import(pathToFileURL(path.join(copy, "index.js")).href);
    const context = { waitUntil() {}, passThroughOnException() {} };
    const functionNames = ["getKeyTransferStatus", "exportEncryptedMigrationKey"];
    async function invoke(name, options = {}) {
      const id = digest(`src/lib/key-transfer.functions.ts--${name}_createServerFn_handler`);
      const headers = { "content-type": "application/json", origin: options.origin ?? SOURCE, "x-tsr-serverfn": "true", "sec-fetch-site": options.fetchSite ?? "same-origin" };
      if (options.token !== null) headers.authorization = `Bearer ${options.token ?? freshJwt}`;
      const method = options.method ?? "POST";
      const response = await worker.fetch(new Request(`${SOURCE}/_serverFn/${id}`, {
        method, headers, ...(method === "POST" ? { body: JSON.stringify(toJSON({ data: options.data ?? {} })) } : {}),
      }), {}, context);
      const text = await response.text();
      httpChecks++;
      assert(!text.includes(SYNTHETIC_MARKER) && !text.includes(privatePem) && ![freshJwt, staleJwt].some(token => text.includes(token)), "HTTP response must not reveal raw key, private key or authentication tokens");
      let decoded;
      if (response.headers.get("x-tss-serialized") === "true") decoded = fromCrossJSON(JSON.parse(text), { refs: new Map(), plugins: defaultSerovalDeserializerPlugins });
      else { try { decoded = JSON.parse(text); } catch { decoded = undefined; } }
      return { response, text, decoded, result: decoded?.result ?? decoded, error: decoded instanceof Error ? decoded : decoded?.error };
    }
    function noStore(result) { assert.match(result.response.headers.get("cache-control") || "", /no-store/, "Transfer POST results, including serialized errors, must not be cached"); }
    function denied(result) {
      assert(result.response.status >= 400 || result.error instanceof Error || result.decoded?.error === "unauthorized", "Access must be rejected by real transport or serialized Error");
      assert(!result.text.includes("wrappedKey") && !result.text.includes("ciphertext") && !result.text.includes('"enabled":true'), "Denied request must not return transfer data");
      assert(!["source_key_unavailable", "crypto_import_failed", "canary_failed", "seal_failed"].some(code => result.text.includes(code)), "Denied request must not return post-authorization diagnostics");
      assert.equal(forbiddenRequests, 0, "No request may escape the allowlisted fake Auth and role RPC");
    }
    for (const name of functionNames) {
      const anonymous = await invoke(name, { token: null }); denied(anonymous); noStore(anonymous);
      const get = await invoke(name, { method: "GET" }); denied(get); assert.equal(get.response.status, 405);
      denied(await invoke(name, { origin: "https://wrong-origin.invalid" }));
      denied(await invoke(name, { fetchSite: "cross-site" }));
      const wrongInput = await invoke(name, { data: { env: "OTHER_SECRET", recipient: "other" } }); denied(wrongInput);
      const stale = await invoke(name, { token: staleJwt }); denied(stale); noStore(stale);
      for (const role of [false, null]) {
        state.role = role;
        const result = await invoke(name); denied(result); noStore(result);
      }
      state.role = true; state.roleError = true;
      const roleError = await invoke(name); denied(roleError); noStore(roleError);
      state.roleError = false; state.userId = "22222222-2222-4222-8222-222222222222";
      const mismatch = await invoke(name); denied(mismatch); noStore(mismatch);
      state.userId = USER_ID; state.anonymous = true;
      const anonymousUser = await invoke(name); denied(anonymousUser); noStore(anonymousUser);
      state.anonymous = false; state.authError = true;
      const authError = await invoke(name); denied(authError); noStore(authError);
      state.authError = false;
    }
    const status = await invoke("getKeyTransferStatus"); noStore(status);
    assert.equal(status.response.status, 200); assert.equal(status.result.enabled, true);
    assert.equal(status.result.keyId, fixture.keyId);
    const exported = await invoke("exportEncryptedMigrationKey"); noStore(exported);
    assert.equal(exported.response.status, 200);
    assert.deepEqual(Object.keys(exported.result).sort(), ["envelope", "ok"]);
    assert.equal(exported.result.ok, true, "Successful RPC must contain the explicit success discriminator");
    decryptEnvelope(exported.result.envelope, pair, fixture);

    // Exercise finite failure codes through the real serialized HTTP transport,
    // not only the isolated handler fixture. These are synthetic env values in
    // this standalone process; no live secret, SDK account or database is used.
    delete process.env.APP_ENCRYPTION_KEY;
    const missingKey = await invoke("exportEncryptedMigrationKey"); noStore(missingKey);
    assert.equal(missingKey.response.status, 200);
    assert.deepEqual(missingKey.result, { ok: false, code: "source_key_unavailable" });
    process.env.APP_ENCRYPTION_KEY = SYNTHETIC_KEY.repeat(1000);
    const rejectedSeal = await invoke("exportEncryptedMigrationKey"); noStore(rejectedSeal);
    assert.equal(rejectedSeal.response.status, 200);
    assert.deepEqual(rejectedSeal.result, { ok: false, code: "seal_failed" });
    process.env.APP_ENCRYPTION_KEY = SYNTHETIC_KEY;
    assert(upstreamCalls > 0, "Positive HTTP test must exercise the actual SDK Auth/role path");
    assert.equal(forbiddenRequests, 0);
    assert(!consoleOutput.some(text => text.includes(SYNTHETIC_MARKER) || text.includes(privatePem) || [freshJwt, staleJwt].some(token => text.includes(token))), "Runtime logs must not include synthetic secrets or tokens");
    assert(fs.readFileSync(configSource).equals(sourceBytes), "Source config bytes must remain unchanged");
    assert.deepEqual(filesUnder(workerDirectory).sort(), workerFiles.sort(), "Deployable worker file list must remain unchanged");
    for (const [file, hash] of before) assert.equal(digest(fs.readFileSync(file)), hash, "Deployable worker bytes must remain unchanged");
  } finally {
    globalThis.fetch = previousFetch;
    Object.assign(console, previousConsole);
    // This is a standalone verifier process, not an imported helper. Never read
    // or retain inherited secret values merely to restore them on process exit.
    for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "APP_ENCRYPTION_KEY"]) delete process.env[name];
    // Validate the exact newly-created absolute target before recursive cleanup.
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved), tempParent);
    assert(path.basename(resolved).startsWith("umbra-key-transfer-http-"));
    fs.rmSync(resolved, { recursive: true, force: false });
  }
  console.log(`Verified ${httpChecks} real key-transfer HTTP requests: Auth/role rejection, no-store, encrypted byte-exact key and canary; synthetic allowlisted upstream only; source/build unchanged`);
}

main().catch(() => {
  // Never print caught errors: assertion details or crypto/runtime causes may
  // contain fixture payloads. The outer reviewer gets a safe failure signal.
  console.error("Key-transfer offline HTTP verification failed; no secret or response details were printed");
  process.exitCode = 1;
});
