import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

export const KEY_TRANSFER_UNAVAILABLE = "Защищённый перенос недоступен. Проверьте окно переноса и повторно войдите по паролю.";
export const KEY_TRANSFER_SOURCE = "https://proxy-pals-hub.lovable.app";
export const KEY_TRANSFER_TARGET = "https://umbra.mafiatrafa.com";
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const PASSWORD_MAX_AGE_SECONDS = 10 * 60;

export type KeyTransferRequest = {
  format: "umbra-key-transfer-request-v1";
  transferId: string;
  keyId: string;
  sourceOrigin: string;
  targetOrigin: string;
  createdAt: string;
  expiresAt: string;
  publicKeySpki: string;
};

export type KeyTransferEnvelope = {
  format: "umbra-key-transfer-v1";
  transferId: string;
  keyId: string;
  sourceOrigin: string;
  targetOrigin: string;
  issuedAt: string;
  expiresAt: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

// Finite owner-only operational outcomes, never exception text or secret
// metadata. This union changes the RPC wrapper, not the encrypted envelope.
export type KeyTransferFailureCode =
  | "source_key_unavailable"
  | "crypto_import_failed"
  | "canary_failed"
  | "seal_failed";
export type KeyTransferExportResult =
  | { ok: true; envelope: KeyTransferEnvelope }
  | { ok: false; code: KeyTransferFailureCode };

function unavailable(): never { throw new Error(KEY_TRANSFER_UNAVAILABLE); }
function canonicalDate(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) unavailable();
  return time;
}

export function validateKeyTransferConfig(config: { enabled: boolean; request: KeyTransferRequest | null }, now: number): KeyTransferRequest {
  if (!config.enabled || !config.request || !Number.isFinite(now)) unavailable();
  const request = config.request;
  if (request.format !== "umbra-key-transfer-request-v1" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.transferId) ||
      !/^[0-9a-f]{64}$/.test(request.keyId) ||
      request.sourceOrigin !== KEY_TRANSFER_SOURCE || request.targetOrigin !== KEY_TRANSFER_TARGET) unavailable();
  const start = canonicalDate(request.createdAt);
  const end = canonicalDate(request.expiresAt);
  if (end <= start || end - start > MAX_WINDOW_MS || now < start || now >= end) unavailable();
  try {
    if (request.publicKeySpki.length > 4096) unavailable();
    const der = Buffer.from(request.publicKeySpki, "base64");
    if (der.toString("base64") !== request.publicKeySpki || createHash("sha256").update(der).digest("hex") !== request.keyId) unavailable();
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) > 4096 || key.asymmetricKeyDetails?.publicExponent !== 65537n) unavailable();
  } catch { unavailable(); }
  return request;
}

export function validateKeyTransferHttp(request: Request, config: KeyTransferRequest): void {
  if (request.method !== "POST" || new URL(request.url).origin !== config.sourceOrigin ||
      request.headers.get("origin") !== config.sourceOrigin) unavailable();
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") unavailable();
}

export function validateRecentPassword(claims: Record<string, unknown>, now: number): void {
  if (claims["is_anonymous"] === true || !Array.isArray(claims["amr"])) unavailable();
  const recent = claims["amr"].some((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    return method === "password" && typeof timestamp === "number" && Number.isInteger(timestamp) &&
      timestamp <= Math.floor(now / 1000) && timestamp >= Math.floor(now / 1000) - PASSWORD_MAX_AGE_SECONDS;
  });
  if (!recent) unavailable();
}

export function sealKeyTransfer(
  secret: string,
  canary: { plain: string; encrypted: string },
  request: KeyTransferRequest,
  now: number,
): KeyTransferEnvelope {
  // Recheck the absolute expiry immediately before using the secret. This
  // operation never updates the original key or any database row.
  validateKeyTransferConfig({ enabled: true, request }, now);
  if (!secret || Buffer.byteLength(secret, "utf8") > 16384 || Buffer.from(secret, "utf8").toString("utf8") !== secret) unavailable();
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const payload = Buffer.from(JSON.stringify({ secretName: "APP_ENCRYPTION_KEY", secret, canary }), "utf8");
  try {
    const metadata = {
      format: "umbra-key-transfer-v1" as const, transferId: request.transferId, keyId: request.keyId,
      sourceOrigin: request.sourceOrigin, targetOrigin: request.targetOrigin,
      issuedAt: new Date(now).toISOString(), expiresAt: request.expiresAt,
    };
    const aad = Buffer.from(JSON.stringify([
      metadata.format, metadata.transferId, metadata.keyId, metadata.sourceOrigin,
      metadata.targetOrigin, metadata.issuedAt, metadata.expiresAt,
    ]), "utf8");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const wrapped = publicEncrypt({
      key: createPublicKey({ key: Buffer.from(request.publicKeySpki, "base64"), format: "der", type: "spki" }),
      padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.alloc(0),
    }, key);
    return {
      ...metadata, wrappedKey: wrapped.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
    };
  } catch { unavailable(); }
  finally { key.fill(0); payload.fill(0); }
}
