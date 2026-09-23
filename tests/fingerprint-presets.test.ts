import { describe, expect, test } from "bun:test";
import { generateFingerprint, describeFingerprint } from "../src/lib/fingerprint";
import { fingerprintSchema } from "../src/lib/server-validation";
import { fingerprintError } from "../src/components/profile-model";

describe("desktop fingerprint presets", () => {
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
          expect(fp.platform).toBe("Win32");
          expect(fp.userAgent).toContain("Windows NT 10.0");
          expect(describeFingerprint(fp)).toStartWith("Windows");
        }
      }
    });
  }
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
});
