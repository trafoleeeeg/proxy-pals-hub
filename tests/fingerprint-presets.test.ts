import { describe, expect, test } from "bun:test";
import { generateFingerprint, describeFingerprint, verifiedProxyTimezone, WINDOWS_CONFIGURATIONS, windowsConfigurationId, applyWindowsConfiguration, windowsUserAgent } from "../src/lib/fingerprint";
import { fingerprintSchema } from "../src/lib/server-validation";
import { fingerprintError, profileFingerprintPayload } from "../src/components/profile-model";

describe("desktop fingerprint presets", () => {
  test("font isolation round-trips without enabling itself for old profiles", () => {
    const fp = generateFingerprint("US");
    expect(fp.fontIsolation).toBe(false);
    const { fontIsolation: _old, ...legacy } = fp;
    expect(fingerprintSchema.parse(legacy).fontIsolation).toBe(false);
    const enabled = { ...fp, fontIsolation: true };
    expect(fingerprintSchema.parse(enabled).fontIsolation).toBe(true);
    expect(applyWindowsConfiguration(enabled, WINDOWS_CONFIGURATIONS[0].id).fontIsolation).toBe(true);
    expect(fingerprintSchema.safeParse({ ...fp, fontIsolation: "true" }).success).toBe(false);
  });
  for (const os of ["windows", "macos"] as const) {
    test(`${os} presets round-trip through the editor and server`, () => {
      for (let i = 0; i < 30; i++) {
        const fp = generateFingerprint("DE", os);
        expect(fingerprintError(fp)).toBeNull();
        expect(fingerprintSchema.parse(fp)).toEqual(fp);
        expect(fp.timezone).toBe("Europe/Berlin");
        expect(fp.languages[0]).toBe("de-DE");
        expect(fp.webrtc).toBe("proxy");
        expect(fp.aggressivePrivacyMode).toBe(false);
        if (os === "macos") {
          expect(fp.platform).toBe("MacIntel");
          expect(fp.architecture).toBe("arm");
          expect(fp.gpu.renderer).toContain("Apple M");
          expect(fp.userAgent).toContain("Macintosh; Intel Mac OS X 10_15_7");
          expect(fp.gpu.renderer).not.toContain("Direct3D");
          expect(describeFingerprint(fp)).toStartWith("macOS");
        } else {
          expect(windowsConfigurationId(fp)).not.toBe("custom");
          expect(fp.gpu).toEqual({ vendor: "", renderer: "" });
          expect(fp.platform).toBe("Win32");
          expect(fp.userAgent).toContain("Windows NT 10.0");
          expect(describeFingerprint(fp)).toStartWith("Windows");
        }
      }
    });
  }
  test("explicit Windows bundles preserve locale, start URL and privacy settings without mutating the source", () => {
    const source = { ...generateFingerprint("FR"), doNotTrack: true, aggressivePrivacyMode: true, startUrl: "https://example.test" };
    const before = structuredClone(source);
    for (const config of WINDOWS_CONFIGURATIONS) {
      const fp = applyWindowsConfiguration(source, config.id);
      expect(windowsConfigurationId(fp)).toBe(config.id);
      expect(fingerprintSchema.parse(fp)).toEqual(fp);
      expect(fingerprintError(fp)).toBeNull();
      expect(fp.languages).toEqual(source.languages);
      expect(fp.timezone).toBe(source.timezone);
      expect(fp.startUrl).toBe(source.startUrl);
      expect(fp.aggressivePrivacyMode).toBe(true);
      expect(fp.doNotTrack).toBe(true);
      expect(fp.userAgent).toBe(windowsUserAgent(fp.chromeVersion));
      expect(windowsConfigurationId({ ...fp, hardwareConcurrency: 3 })).toBe("custom");
    }
    expect(source).toEqual(before);
    expect(describeFingerprint({ ...source, osVersion: "11.0.0" })).toStartWith("Windows 11");
    expect(profileFingerprintPayload({ ...source, userAgent: "Windows NT 11.0 Chrome/99 Electron/10" }).userAgent).toBe(windowsUserAgent(source.chromeVersion));
  });
  test("older Windows profiles without architecture or privacy mode stay valid", () => {
    const { architecture: _, aggressivePrivacyMode: __, ...fp } = generateFingerprint();
    expect(fingerprintSchema.parse(fp).aggressivePrivacyMode).toBe(true);
    expect(fingerprintError(fp)).toBeNull();
  });
  test("strict mode is accepted and non-boolean privacy modes are rejected", () => {
    const fp = generateFingerprint();
    expect(fingerprintSchema.safeParse({ ...fp, aggressivePrivacyMode: true }).success).toBe(true);
    expect(fingerprintSchema.safeParse({ ...fp, aggressivePrivacyMode: "false" }).success).toBe(false);
  });
  test("editor rejects mixed platform and UA values", () => {
    const mac = generateFingerprint(null, "macos");
    expect(fingerprintError({ ...mac, platform: "Win32" })).not.toBeNull();
    expect(fingerprintError({ ...mac, userAgent: generateFingerprint().userAgent })).not.toBeNull();
    expect(fingerprintSchema.safeParse({ ...mac, architecture: "invalid" }).success).toBe(false);
    expect(fingerprintSchema.safeParse({ ...mac, osVersion: "not a version" }).success).toBe(false);
  });
  test("timezone suggestion requires a fresh successful check for the same proxy IP", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const proxy = { last_check_ok: true, last_checked_at: "2026-09-29T11:55:00Z", last_check_ip: "107.77.234.56", geoTimezone: "America/Chicago" };
    expect(verifiedProxyTimezone(proxy, now)).toBe("America/Chicago");
    expect(verifiedProxyTimezone({ ...proxy, last_checked_at: "2026-09-29T11:30:00Z" }, now)).toBeNull();
    expect(verifiedProxyTimezone({ ...proxy, last_check_ip: null }, now)).toBeNull();
    expect(verifiedProxyTimezone({ ...proxy, last_check_ok: false }, now)).toBeNull();
    expect(verifiedProxyTimezone({ ...proxy, geoTimezone: "not/a-timezone" }, now)).toBeNull();
  });
});
