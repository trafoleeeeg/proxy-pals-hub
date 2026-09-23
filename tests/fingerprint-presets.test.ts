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
        expect(fp.webrtc).toBe("disabled");
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
  test("older Windows profiles without architecture stay valid", () => {
    const { architecture: _, ...fp } = generateFingerprint();
    expect(fingerprintSchema.safeParse(fp).success).toBe(true);
    expect(fingerprintError(fp)).toBeNull();
  });
  test("editor rejects mixed platform and UA values", () => {
    const mac = generateFingerprint(null, "macos");
    expect(fingerprintError({ ...mac, platform: "Win32" })).not.toBeNull();
    expect(fingerprintError({ ...mac, userAgent: generateFingerprint().userAgent })).not.toBeNull();
    expect(fingerprintSchema.safeParse({ ...mac, architecture: "invalid" }).success).toBe(false);
    expect(fingerprintSchema.safeParse({ ...mac, osVersion: "not a version" }).success).toBe(false);
  });
});
