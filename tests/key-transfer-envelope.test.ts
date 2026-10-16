import { expect, test } from "bun:test";
import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { KEY_TRANSFER_SOURCE, KEY_TRANSFER_TARGET, KEY_TRANSFER_UNAVAILABLE, sealKeyTransfer, validateKeyTransferConfig, validateKeyTransferHttp, validateRecentPassword, type KeyTransferEnvelope, type KeyTransferRequest } from "../src/lib/key-transfer.server";

const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const spki = pair.publicKey.export({ format: "der", type: "spki" });
const now = Date.now();
const request: KeyTransferRequest = {
  format: "umbra-key-transfer-request-v1", transferId: randomUUID(),
  keyId: createHash("sha256").update(spki).digest("hex"), publicKeySpki: spki.toString("base64"),
  sourceOrigin: KEY_TRANSFER_SOURCE, targetOrigin: KEY_TRANSFER_TARGET,
  createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
};

export function openSyntheticEnvelope(envelope: KeyTransferEnvelope) {
  const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.alloc(0) }, Buffer.from(envelope.wrappedKey, "base64"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(JSON.stringify([envelope.format, envelope.transferId, envelope.keyId, envelope.sourceOrigin, envelope.targetOrigin, envelope.issuedAt, envelope.expiresAt]), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } finally { key.fill(0); }
}

test.each(["synthetic-only-key", "  synthetic-key  \r\n", "\tключ🙂\n", " "])("encrypted envelope preserves the exact synthetic UTF-8 key %#", (raw) => {
  const envelope = sealKeyTransfer(raw, { plain: "safe-synthetic-challenge", encrypted: "synthetic-canary" }, request, now);
  const payload = openSyntheticEnvelope(envelope);
  expect(payload.secretName).toBe("APP_ENCRYPTION_KEY");
  expect(Buffer.from(payload.secret, "utf8").equals(Buffer.from(raw, "utf8"))).toBe(true);
  expect(Object.keys(envelope).sort()).toEqual(["format", "transferId", "keyId", "sourceOrigin", "targetOrigin", "issuedAt", "expiresAt", "wrappedKey", "iv", "tag", "ciphertext"].sort());
  expect(JSON.stringify(envelope)).not.toContain(raw);
});

test("every export has independent wrapping and GCM randomness", () => {
  const first = sealKeyTransfer("synthetic", { plain: "test", encrypted: "test" }, request, now);
  const second = sealKeyTransfer("synthetic", { plain: "test", encrypted: "test" }, request, now);
  expect(first.iv).not.toBe(second.iv);
  expect(first.wrappedKey).not.toBe(second.wrappedKey);
  expect(first.ciphertext).not.toBe(second.ciphertext);
});

test.each(["format", "transferId", "keyId", "sourceOrigin", "targetOrigin", "issuedAt", "expiresAt", "wrappedKey", "iv", "tag", "ciphertext"] as const)("tampering %s is rejected cryptographically", (field) => {
  const envelope = sealKeyTransfer("synthetic-only", { plain: "test", encrypted: "test" }, request, now);
  const changed = { ...envelope, [field]: field === "iv" ? Buffer.alloc(12, 7).toString("base64") : envelope[field].slice(0, -4) + "AAAA" };
  expect(() => openSyntheticEnvelope(changed)).toThrow();
});

test("another recipient cannot unwrap the envelope", () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const envelope = sealKeyTransfer("synthetic", { plain: "test", encrypted: "test" }, request, now);
  expect(() => privateDecrypt({ key: other.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.wrappedKey, "base64"))).toThrow();
});

test.each([
  { enabled: false, request }, { enabled: true, request: null },
  { enabled: true, request: { ...request, sourceOrigin: "https://attacker.example" } },
  { enabled: true, request: { ...request, targetOrigin: "https://attacker.example" } },
  { enabled: true, request: { ...request, transferId: "arbitrary-transfer" } },
  { enabled: true, request: { ...request, keyId: "0".repeat(64) } },
  { enabled: true, request: { ...request, publicKeySpki: request.publicKeySpki + "\n" } },
  { enabled: true, request: { ...request, expiresAt: new Date(now).toISOString() } },
  { enabled: true, request: { ...request, createdAt: new Date(now + 1000).toISOString() } },
  { enabled: true, request: { ...request, expiresAt: new Date(now + 86400001).toISOString() } },
  { enabled: true, request: { ...request, expiresAt: "invalid-date" } },
])("invalid/disabled transfer configuration fails closed %#", (config) => {
  expect(() => validateKeyTransferConfig(config, now)).toThrow(KEY_TRANSFER_UNAVAILABLE);
});

test("weak or non-RSA public recipients are refused", () => {
  for (const publicKey of [generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey]) {
    const der = publicKey.export({ format: "der", type: "spki" });
    expect(() => validateKeyTransferConfig({ enabled: true, request: { ...request, publicKeySpki: der.toString("base64"), keyId: createHash("sha256").update(der).digest("hex") } }, now)).toThrow(KEY_TRANSFER_UNAVAILABLE);
  }
});

test.each([
  new Request(KEY_TRANSFER_SOURCE + "/_serverFn/test", { method: "GET", headers: { origin: KEY_TRANSFER_SOURCE } }),
  new Request(KEY_TRANSFER_SOURCE + "/_serverFn/test", { method: "POST" }),
  new Request(KEY_TRANSFER_SOURCE + "/_serverFn/test", { method: "POST", headers: { origin: "https://attacker.example" } }),
  new Request("https://attacker.example/_serverFn/test", { method: "POST", headers: { origin: KEY_TRANSFER_SOURCE } }),
  new Request(KEY_TRANSFER_SOURCE + "/_serverFn/test", { method: "POST", headers: { origin: KEY_TRANSFER_SOURCE, "sec-fetch-site": "cross-site" } }),
])("missing/wrong origin, cross-site and GET are refused %#", (http) => {
  expect(() => validateKeyTransferHttp(http, request)).toThrow(KEY_TRANSFER_UNAVAILABLE);
});

test("same-origin POST is accepted", () => {
  expect(() => validateKeyTransferHttp(new Request(KEY_TRANSFER_SOURCE + "/_serverFn/test", { method: "POST", headers: { origin: KEY_TRANSFER_SOURCE, "sec-fetch-site": "same-origin" } }), request)).not.toThrow();
});

test.each([
  {}, { iat: Math.floor(now / 1000) }, { amr: [] },
  { amr: [{ method: "oauth", timestamp: Math.floor(now / 1000) }] },
  { amr: [{ method: "password", timestamp: Math.floor(now / 1000) - 601 }] },
  { amr: [{ method: "password", timestamp: Math.floor(now / 1000) + 1 }] },
  { amr: [{ method: "password", timestamp: String(Math.floor(now / 1000)) }] },
  { is_anonymous: true, amr: [{ method: "password", timestamp: Math.floor(now / 1000) }] },
])("fresh JWT iat is not a substitute for recent password authentication %#", (claims) => {
  expect(() => validateRecentPassword(claims, now)).toThrow(KEY_TRANSFER_UNAVAILABLE);
});

test("a genuine recent password AMR is required and accepted", () => {
  expect(() => validateRecentPassword({ amr: [{ method: "password", timestamp: Math.floor(now / 1000) - 30 }] }, now)).not.toThrow();
});
