import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function getKey(): Buffer {
  const raw = process.env["APP_ENCRYPTION_KEY"];
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is not configured");
  return createHash("sha256").update(raw).digest();
}

/** AES-256-GCM. Output: base64(iv).base64(tag).base64(ciphertext) */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(
    ".",
  );
}

export function decryptSecret(payload: string | null | undefined): string {
  if (!payload) return "";
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Encrypted secret is invalid");
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  try {
    const buffers = [ivB64, tagB64, dataB64].map((part) => {
      const buffer = Buffer.from(part, "base64");
      if (!part || buffer.toString("base64") !== part) throw new Error("Invalid encoding");
      return buffer;
    });
    const [iv, tag, encrypted] = buffers as [Buffer, Buffer, Buffer];
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt secret; check the encryption key and stored data");
  }
}
