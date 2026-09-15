import { afterEach, describe, expect, test } from "bun:test";
import { encryptSecret, decryptSecret } from "../src/lib/crypto.server";
import { parseCookieImport } from "../src/lib/server-cookies";
import { bulkCreateSchema, bulkUpdateSchema, fingerprintSchema, launchSchema } from "../src/lib/server-validation";
import { generateFingerprint } from "../src/lib/fingerprint";

const previousKey = process.env.APP_ENCRYPTION_KEY;
afterEach(() => {
  if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = previousKey;
});
describe("encrypted profile data", () => {
  test("authenticated encryption round-trips and never silently empties a wrong-key secret", () => {
    process.env.APP_ENCRYPTION_KEY = "synthetic-test-key";
    const encrypted = encryptSecret("synthetic-cookie-value");
    expect(encrypted).not.toContain("synthetic-cookie-value");
    expect(decryptSecret(encrypted)).toBe("synthetic-cookie-value");
    process.env.APP_ENCRYPTION_KEY = "different-test-key";
    expect(() => decryptSecret(encrypted)).toThrow("Unable to decrypt");
  });
  test("malformed envelopes and missing keys fail without echoing their input", () => {
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => encryptSecret("value")).toThrow("not configured");
    for (const input of ["synthetic-private-plaintext", "a.b.c", "!invalid!.envelope.secret"]) {
      expect(() => decryptSecret(input)).toThrow();
      try { decryptSecret(input); }
      catch (error) { expect(String(error)).not.toContain(input); }
    }
    expect(decryptSecret(null)).toBe("");
  });
});

describe("cookie imports", () => {
  test("JSON, wrapper and Netscape imports preserve session and host-only semantics", () => {
    const json = [{ name: "session", value: "synthetic", domain: "example.test", hostOnly: true, session: true, expirationDate: 2000000000, sameSite: "Lax" }];
    const cookie = parseCookieImport(JSON.stringify({ cookies: json }))[0]!;
    expect(cookie).toMatchObject({ hostOnly: true, session: true, sameSite: "lax", path: "/" });
    expect(cookie.expirationDate).toBeUndefined();
    expect(parseCookieImport("# Netscape HTTP Cookie File\n#HttpOnly_.example.test\tTRUE\t/\tTRUE\t0\tname\tvalue")[0]).toMatchObject({ httpOnly: true, secure: true, hostOnly: false, session: true });
  });
  test("empty explicit collections are accepted, malformed data is rejected without secrets", () => {
    expect(parseCookieImport("[]")).toEqual([]);
    for (const text of ["", "{}", "synthetic-private-data", '[{"name":"x","domain":"https://bad","value":"synthetic-private-data"}]']) {
      expect(() => parseCookieImport(text)).toThrow();
      try { parseCookieImport(text); } catch (error) { expect(String(error)).not.toContain("synthetic-private-data"); }
    }
  });
});

describe("server input validation", () => {
  test("newly generated Windows fingerprints pass schema with a real engine version", () => {
    for (let i = 0; i < 20; i++) {
      const fingerprint = generateFingerprint("US");
      expect(fingerprintSchema.safeParse(fingerprint).success).toBe(true);
      expect(fingerprint.userAgent).toContain("Windows NT 10.0");
      expect([4, 8]).toContain(fingerprint.deviceMemory);
    }
  });
  test("invalid UUIDs, mismatched counts and duplicate bulk IDs fail before touching the database", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    expect(launchSchema.safeParse({ profileId: "../escape" }).success).toBe(false);
    expect(bulkCreateSchema.safeParse({ teamId: id, prefix: "A", count: 2, folder: "", fingerprints: [generateFingerprint("US")] }).success).toBe(false);
    expect(bulkUpdateSchema.safeParse({ teamId: id, ids: [id, id], changes: { folder: "Ready" } }).success).toBe(false);
    expect(bulkUpdateSchema.safeParse({ teamId: id, ids: [id], changes: {} }).success).toBe(false);
  });
});
