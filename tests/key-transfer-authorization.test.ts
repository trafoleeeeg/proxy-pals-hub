import { afterEach, expect, test } from "bun:test";
import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KEY_TRANSFER_SOURCE, KEY_TRANSFER_TARGET, KEY_TRANSFER_UNAVAILABLE } from "../src/lib/key-transfer.server";

const source = fileURLToPath(new URL("../src/lib/key-transfer.functions.ts", import.meta.url));
const contents = readFileSync(source, "utf8");
const rawAccess = 'process.env["APP_ENCRYPTION_KEY"]';
if (contents.split(rawAccess).length !== 2) throw new Error("Fixture requires the single explicit APP key read");
const modules: Record<string, string> = {
  entry: `export * from ${JSON.stringify(source)}; export { state } from 'transfer-test:state';`,
  state: `export const state = { auth: true, config: { enabled: false, request: null }, http: null, claims: {},
    secret: 'SYNTHETIC_ONLY_MUST_NOT_APPEAR_IN_ERRORS', reads: 0, calls: [], headers: {},
    user: { data: { user: { id: 'synthetic-owner', is_anonymous: false } }, error: null },
    role: { data: true, error: null }, roleThrows: false, userThrows: false, expireDuringUser: false, canaryThrows: false };
    export function readSyntheticKey() { state.reads++; state.calls.push('secret'); return state.secret; }`,
  start: `import { state } from 'transfer-test:state';
    export function createMiddleware() { return { server: fn => ({ run: fn }) }; }
    export function createServerFn(options) {
      let middlewares = [], validator;
      const builder = { middleware(list) { middlewares = list; return builder; },
        inputValidator(fn) { validator = fn; return builder; },
        handler(fn) { const call = async ({ data = {} } = {}) => {
          const context = { userId: 'synthetic-owner', claims: state.claims,
            supabase: { auth: { getUser: async () => { state.calls.push('getUser'); if (state.userThrows) throw new Error(state.secret); if (state.expireDuringUser) state.config.request.expiresAt = new Date(Date.now() - 1).toISOString(); return state.user; } },
              rpc: async name => { state.calls.push(name); if (state.roleThrows) throw new Error(state.secret); return state.role; } } };
          const valid = validator ? validator(data) : data;
          const run = async i => i < middlewares.length ? middlewares[i].run({ next: () => run(i + 1) }) : fn({ data: valid, context });
          return run(0);
        }; call.method = options.method; return call; } }; return builder;
    }`,
  server: `import { state } from 'transfer-test:state'; export const getRequest = () => state.http;
    export const setResponseHeader = (name, value) => { state.headers[name] = value; };`,
  auth: `import { state } from 'transfer-test:state'; export const requireSupabaseAuth = { run: ({ next }) => {
    state.calls.push('auth'); if (!state.auth) throw new Error('Unauthorized: synthetic'); return next(); } };`,
  config: `import { state } from 'transfer-test:state'; export const keyTransferConfig = state.config;`,
  canary: `import { state } from 'transfer-test:state'; import { createCipheriv, createHash, randomBytes } from 'node:crypto';
    export const encryptSecret = plain => { if (state.canaryThrows) throw new Error(state.secret); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(state.secret).digest(), iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64')).join('.'); };`,
};
const built = await Bun.build({ entrypoints: ["transfer-test:entry"], target: "bun", write: false,
  plugins: [{ name: "isolated-key-transfer-auth", setup(build) {
    build.onResolve({ filter: /^transfer-test:/ }, ({ path }) => ({ path: path.slice(14), namespace: "transfer-test" }));
    build.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({ path: "start", namespace: "transfer-test" }));
    build.onResolve({ filter: /^@tanstack\/react-start\/server$/ }, () => ({ path: "server", namespace: "transfer-test" }));
    build.onResolve({ filter: /^@\/integrations\/supabase\/auth-middleware$/ }, () => ({ path: "auth", namespace: "transfer-test" }));
    build.onResolve({ filter: /^\.\/key-transfer-config\.server$/ }, () => ({ path: "config", namespace: "transfer-test" }));
    build.onResolve({ filter: /^\.\/crypto\.server$/ }, () => ({ path: "canary", namespace: "transfer-test" }));
    build.onLoad({ filter: /key-transfer\.functions\.ts$/ }, () => ({
      contents: `import { readSyntheticKey } from 'transfer-test:state';\n` + contents.replace(rawAccess, "readSyntheticKey()"),
      loader: "ts", resolveDir: fileURLToPath(new URL("../src/lib", import.meta.url)),
    }));
    build.onLoad({ filter: /.*/, namespace: "transfer-test" }, ({ path }) => ({ contents: modules[path]!, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
  } }],
});
if (!built.success) throw new AggregateError(built.logs);
const fixture = join(mkdtempSync(join(tmpdir(), "umbra-key-auth-")), "fixture.js");
writeFileSync(fixture, await built.outputs[0]!.text());
const api = await import(pathToFileURL(fixture).href);
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const der = pair.publicKey.export({ format: "der", type: "spki" });

function reset() {
  const now = Date.now();
  api.state.auth = true; api.state.reads = 0; api.state.calls = []; api.state.headers = {};
  api.state.secret = "  SYNTHETIC_ONLY_MUST_NOT_APPEAR_IN_ERRORS🙂\r\n";
  api.state.claims = { amr: [{ method: "password", timestamp: Math.floor(now / 1000) }] };
  api.state.http = new Request(KEY_TRANSFER_SOURCE + "/_serverFn/synthetic", { method: "POST", headers: { origin: KEY_TRANSFER_SOURCE, "sec-fetch-site": "same-origin" } });
  api.state.config.enabled = true; api.state.config.request = {
    format: "umbra-key-transfer-request-v1", transferId: randomUUID(), keyId: createHash("sha256").update(der).digest("hex"),
    publicKeySpki: der.toString("base64"), sourceOrigin: KEY_TRANSFER_SOURCE, targetOrigin: KEY_TRANSFER_TARGET,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
  };
  api.state.user = { data: { user: { id: "synthetic-owner", is_anonymous: false } }, error: null };
  api.state.role = { data: true, error: null }; api.state.roleThrows = false; api.state.userThrows = false;
  api.state.expireDuringUser = false; api.state.canaryThrows = false;
}
reset(); afterEach(reset);

test("actual handler builder requires POST, auth and no-store before its key read", async () => {
  expect(api.exportEncryptedMigrationKey.method).toBe("POST");
  const result = await api.exportEncryptedMigrationKey({ data: {} });
  expect(result.format).toBe("umbra-key-transfer-v1");
  expect(api.state.calls).toEqual(["auth", "getUser", "is_superadmin", "secret"]);
  expect(api.state.reads).toBe(1);
  expect(api.state.headers["Cache-Control"]).toContain("no-store");
  expect(JSON.stringify(result)).not.toContain(api.state.secret);
  const wrappingKey = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(result.wrappedKey, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, Buffer.from(result.iv, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify([result.format, result.transferId, result.keyId, result.sourceOrigin, result.targetOrigin, result.issuedAt, result.expiresAt])));
  decipher.setAuthTag(Buffer.from(result.tag, "base64"));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(result.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  wrappingKey.fill(0);
  expect(payload.secret).toBe(api.state.secret);
  const [iv, tag, data] = payload.canary.encrypted.split(".").map((part: string) => Buffer.from(part, "base64"));
  const canary = createDecipheriv("aes-256-gcm", createHash("sha256").update(payload.secret, "utf8").digest(), iv);
  canary.setAuthTag(tag);
  expect(Buffer.concat([canary.update(data), canary.final()]).toString("utf8")).toBe(payload.canary.plain);
});

test.each([
  ["anonymous", () => { api.state.auth = false; }],
  ["missing recent password", () => { api.state.claims = { iat: Math.floor(Date.now() / 1000) }; }],
  ["disabled", () => { api.state.config.enabled = false; }],
  ["expired", () => { api.state.config.request.expiresAt = new Date(Date.now() - 1).toISOString(); }],
  ["expires while Auth/RPC is in flight", () => { api.state.expireDuringUser = true; }],
  ["wrong source", () => { api.state.http = new Request("https://other.example/rpc", { method: "POST", headers: { origin: KEY_TRANSFER_SOURCE } }); }],
  ["missing origin", () => { api.state.http = new Request(KEY_TRANSFER_SOURCE + "/rpc", { method: "POST" }); }],
  ["GET", () => { api.state.http = new Request(KEY_TRANSFER_SOURCE + "/rpc", { headers: { origin: KEY_TRANSFER_SOURCE } }); }],
  ["ordinary member/manager/team owner", () => { api.state.role = { data: false, error: null }; }],
  ["null superadmin", () => { api.state.role = { data: null, error: null }; }],
  ["RPC error with true data", () => { api.state.role = { data: true, error: { message: api.state.secret } }; }],
  ["RPC throws", () => { api.state.roleThrows = true; }],
  ["Auth throws", () => { api.state.userThrows = true; }],
  ["Auth error", () => { api.state.user.error = { message: api.state.secret }; }],
  ["Auth user mismatch", () => { api.state.user.data.user.id = "different-owner"; }],
  ["Auth anonymous user", () => { api.state.user.data.user.is_anonymous = true; }],
] as const)("%s is refused before APP key access", async (_name, change) => {
  change();
  let error: unknown;
  try { await api.exportEncryptedMigrationKey({ data: {} }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(api.state.secret);
  expect((error as Error).cause).toBeUndefined();
  expect(api.state.reads).toBe(0);
});

test.each([{ recipient: "other" }, { env: "OTHER_SECRET" }, { publicKeySpki: "other" }, null, "", []])("unrecognized inputs cannot select another secret or recipient %#", async (data) => {
  await expect(api.exportEncryptedMigrationKey({ data })).rejects.toThrow(KEY_TRANSFER_UNAVAILABLE);
  expect(api.state.reads).toBe(0);
});

test("status never reads the secret and disabled is not mistaken for ready", async () => {
  expect((await api.getKeyTransferStatus({ data: {} })).enabled).toBe(true);
  api.state.config.enabled = false;
  expect(await api.getKeyTransferStatus({ data: {} })).toEqual({ enabled: false });
  expect(api.state.reads).toBe(0);
});

test("nested crypto/Auth/RPC errors cannot serialize secret values", async () => {
  api.state.roleThrows = true;
  await expect(api.exportEncryptedMigrationKey({ data: {} })).rejects.toThrow(KEY_TRANSFER_UNAVAILABLE);
  expect(api.state.reads).toBe(0);
});

test.each(["missing", "oversized", "crypto error"])("%s APP-key failure has a generic response only", async (failure) => {
  if (failure === "missing") api.state.secret = "";
  if (failure === "oversized") api.state.secret = "SYNTHETIC".repeat(3000);
  if (failure === "crypto error") api.state.canaryThrows = true;
  try { await api.exportEncryptedMigrationKey({ data: {} }); throw new Error("unexpected success"); }
  catch (error) {
    expect((error as Error).message).toBe(KEY_TRANSFER_UNAVAILABLE);
    expect((error as Error).cause).toBeUndefined();
    expect(api.state.reads).toBe(1);
  }
});
