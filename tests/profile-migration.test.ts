import { describe, expect, test } from "bun:test";
import { generateFingerprint } from "../src/lib/fingerprint";
import { fingerprintError, profileFingerprintPayload } from "../src/components/profile-model";
import { fingerprintSchema } from "../src/lib/server-validation";
import { MAX_MIGRATION_BYTES, TG_CHANNEL_SETTINGS, parseMigrationSettings, previewMigration } from "../src/lib/profile-migration";

describe("public Windows migration settings", () => {
  test("screenshot preset applies supported scalars without guessing RAM or weakening protection", () => {
    const current = { ...generateFingerprint("DE"), aggressivePrivacyMode: true, fontIsolation: true, doNotTrack: true,
      webrtc: "disabled" as const, startUrl: "https://example.test", deviceMemory: 4 };
    const before = structuredClone(current);
    const source = parseMigrationSettings(JSON.stringify(TG_CHANNEL_SETTINGS));
    const { fingerprint, rows } = previewMigration(current, source);
    expect(fingerprint.osVersion).toBe("11.0");
    expect(fingerprint.screen.width).toBe(1600); expect(fingerprint.screen.height).toBe(900);
    expect(fingerprint.hardwareConcurrency).toBe(12); expect(fingerprint.deviceMemory).toBe(4);
    for (const key of ["aggressivePrivacyMode", "fontIsolation", "doNotTrack", "webrtc", "startUrl", "gpu", "fontsPreset", "canvasNoise", "audioNoise", "webglNoise", "chromeVersion", "languages", "timezone"] as const)
      expect(fingerprint[key]).toEqual(current[key]);
    expect(rows.find(row => row.parameter === "Память API")?.status).toBe("warning");
    expect(rows.find(row => row.parameter === "GPU / Canvas / Audio")?.detail).toContain("RTX 4060");
    expect(rows.find(row => row.parameter === "Шрифты / устройства")?.detail).toContain("154");
    expect(fingerprintError(fingerprint)).toBeNull();
    expect(fingerprintSchema.parse(profileFingerprintPayload(fingerprint))).toEqual(fingerprint);
    expect(current).toEqual(before); expect(source).toEqual(TG_CHANNEL_SETTINGS);
  });
  test("exact locale and supported reported RAM apply while source UA is not impersonated", () => {
    const current = generateFingerprint("US");
    const source = parseMigrationSettings(JSON.stringify({ format: "umbra-settings-v1", os: "windows", osVersion: "10",
      languages: ["de-de", "de", "de-DE"], timezone: "Europe/Berlin", deviceMemory: 8,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0" }));
    const { fingerprint, rows } = previewMigration(current, source);
    expect(fingerprint.languages).toEqual(["de-DE", "de"]); expect(fingerprint.language).toBe("de-DE");
    expect(fingerprint.timezone).toBe("Europe/Berlin"); expect(fingerprint.deviceMemory).toBe(8);
    expect(fingerprint.chromeVersion).toBe(current.chromeVersion);
    expect(fingerprint.userAgent).toContain(`Chrome/${current.chromeVersion.split(".")[0]}.0.0.0`);
    expect(rows.find(row => row.parameter === "User-Agent")?.status).toBe("warning");
  });
  for (const memory of [0.25, 1, 16, 32]) test(`unsupported reported memory ${memory} is disclosed, not coerced or applied`, () => {
    const current = { ...generateFingerprint(), deviceMemory: 4 };
    const source = parseMigrationSettings(JSON.stringify({ format: "umbra-settings-v1", os: "windows", deviceMemory: memory }));
    const preview = previewMigration(current, source);
    expect(preview.fingerprint.deviceMemory).toBe(4);
    expect(preview.rows.find(row => row.parameter === "Память API")?.detail).toContain(`${memory} ГБ`);
  });
  for (const payload of [[], { data: "encrypted octo export" }, { ...TG_CHANNEL_SETTINGS, cookies: [] },
    { ...TG_CHANNEL_SETTINGS, password: "secret" }, { ...TG_CHANNEL_SETTINGS, proxy: { password: "secret" } },
    { ...TG_CHANNEL_SETTINGS, os: "macos" }, { ...TG_CHANNEL_SETTINGS, hardwareConcurrency: 0 },
    { ...TG_CHANNEL_SETTINGS, screen: { width: 1600, height: 900, extra: "unknown" } },
    { ...TG_CHANNEL_SETTINGS, languages: ["invalid language!"] }, { ...TG_CHANNEL_SETTINGS, timezone: "invalid/zone" },
    { ...TG_CHANNEL_SETTINGS, userAgent: "injected\r\nheader" }]) test(`reject invalid or secret-bearing settings ${JSON.stringify(payload).slice(0, 55)}`, () => {
    expect(() => parseMigrationSettings(JSON.stringify(payload))).toThrow();
  });
  test("oversized and malformed input do not leak values in errors", () => {
    expect(() => parseMigrationSettings("x".repeat(MAX_MIGRATION_BYTES + 1))).toThrow("16 КБ");
    expect(() => parseMigrationSettings("secret-token-not-json")).toThrow("Нужен JSON");
    try { parseMigrationSettings(JSON.stringify({ ...TG_CHANNEL_SETTINGS, password: "private-password" })); }
    catch (error) { expect(String(error)).not.toContain("private-password"); }
  });
  test("preview result owns arrays and nested scalar objects", () => {
    const current = generateFingerprint(); const preview = previewMigration(current, TG_CHANNEL_SETTINGS);
    preview.fingerprint.languages.push("fr"); preview.fingerprint.gpu.renderer = "changed";
    preview.fingerprint.screen.width = 1900;
    expect(current.languages).not.toContain("fr"); expect(current.gpu.renderer).toBe("");
    expect(TG_CHANNEL_SETTINGS.screen?.width).toBe(1600);
  });
});
