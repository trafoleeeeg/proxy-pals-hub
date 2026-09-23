import { describe, expect, test } from "bun:test";
import { cookiesToNetscape, fingerprintError, profileFingerprintPayload, splitTags, toggleVisibleSelection } from "../src/components/profile-model";
import { generateFingerprint } from "../src/lib/fingerprint";

describe("profile UI data", () => {
  test("selecting filtered rows retains hidden selections and deselects only visible rows", () => {
    expect(toggleVisibleSelection(["hidden", "a"], ["a", "b"], true)).toEqual(["hidden", "a", "b"]);
    expect(toggleVisibleSelection(["hidden", "a", "b"], ["a", "b"], false)).toEqual(["hidden"]);
    expect(toggleVisibleSelection([], [], true)).toEqual([]);
  });
  test("tag editing trims, clears, and deduplicates tags", () => {
    expect(splitTags(" a, ,b,a ")).toEqual(["a", "b"]);
    expect(splitTags(" , ")).toEqual([]);
  });
  test("fingerprint editor rejects invalid timezone, language, dimensions and excessive memory", () => {
    const fp = { ...generateFingerprint(), deviceMemory: 8, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
    expect(fingerprintError(fp)).toBeNull();
    expect(fingerprintError({ ...fp, timezone: "invalid/zone" })).not.toBeNull();
    expect(fingerprintError({ ...fp, language: "ru_RU" })).not.toBeNull();
    expect(fingerprintError({ ...fp, screen: { ...fp.screen, width: -1 } })).not.toBeNull();
    expect(fingerprintError({ ...fp, hardwareConcurrency: 0 })).not.toBeNull();
    expect(fingerprintError({ ...fp, deviceMemory: 16 })).not.toBeNull();
    expect(fingerprintError({ ...fp, userAgent: "Windows NT 11.0" })).not.toBeNull();
  });
  test("start URL cannot execute scripts, access files, or contain credentials", () => {
    const fp = { ...generateFingerprint(), deviceMemory: 8, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
    for (const startUrl of ["javascript:alert(1)", "file:///C:/private", "https://user:password@example.com", "not a URL"]) expect(fingerprintError({ ...fp, startUrl })).not.toBeNull();
    expect(fingerprintError({ ...fp, startUrl: "https://example.com/path" })).toBeNull();
  });
  test("cleared optional URLs are omitted from the strict server payload", () => {
    const fp = { ...generateFingerprint(), startUrl: "" };
    expect(profileFingerprintPayload(fp)).not.toHaveProperty("startUrl");
    expect(profileFingerprintPayload({ ...fp, startUrl: " https://example.com " }).startUrl).toBe("https://example.com");
    expect(fingerprintError({ ...fp, deviceMemory: 0.5 })).not.toBeNull();
    expect(fingerprintError({ ...fp, userAgent: "Windows NT 10.0" + "a".repeat(1024) })).not.toBeNull();
  });
  test("new profiles save normal mode while legacy profiles preserve strict mode", () => {
    const fp = generateFingerprint();
    expect(profileFingerprintPayload(fp).aggressivePrivacyMode).toBe(false);
    const { aggressivePrivacyMode: _, ...legacy } = fp;
    expect(profileFingerprintPayload(legacy).aggressivePrivacyMode).toBe(true);
    expect(profileFingerprintPayload({ ...legacy, aggressivePrivacyMode: false }).aggressivePrivacyMode).toBe(false);
  });
  test("Netscape export preserves HttpOnly, domain scope, expiry and session cookies", () => {
    const text = cookiesToNetscape(JSON.stringify([
      { domain: ".example.com", name: "a", value: "one", path: "/", httpOnly: true, secure: true, expirationDate: 1700000000.9 },
      { domain: "example.com", name: "b", value: "", hostOnly: true, session: true },
      { domain: "example.org", name: "c", value: "domain-cookie", hostOnly: false, session: true },
    ]));
    expect(text).toContain("#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1700000000\ta\tone");
    expect(text).toContain("example.com\tFALSE\t/\tFALSE\t0\tb\t");
    expect(text).toContain("example.org\tTRUE\t/\tFALSE\t0\tc\tdomain-cookie");
  });
  test("Netscape export refuses newline injection and invalid cookie collections", () => {
    for (const value of ["{}", "[null]", JSON.stringify([{ domain: "example.com", name: "test", value: "a\nb" }])]) expect(() => cookiesToNetscape(value)).toThrow();
  });
});
