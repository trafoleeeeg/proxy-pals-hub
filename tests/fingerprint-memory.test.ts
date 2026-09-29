import { describe, expect, test } from "bun:test";
import { generateFingerprint } from "../src/lib/fingerprint";
import { SUPPORTED_PROFILE_MEMORY, isSupportedProfileMemory } from "../src/lib/fingerprint-memory";
import { bulkCreateSchema, bulkUpdateSchema, fingerprintSchema, saveProfileSchema } from "../src/lib/server-validation";
import { fingerprintError, profileFingerprintPayload } from "../src/components/profile-model";

const id = "10000000-0000-4000-8000-000000000001";
const fp = generateFingerprint("US");
const save = (deviceMemory: number) => ({
  teamId: id, name: "Memory audit", folder: "", tags: [], notes: "", proxyId: null,
  fingerprint: { ...fp, deviceMemory },
});

describe("compatible reported desktop memory", () => {
  test("UI and every write schema accept only values supported by the shipped engine", () => {
    expect(SUPPORTED_PROFILE_MEMORY).toEqual([2, 4, 8]);
    for (const memory of [0.25, 0.5, 1, 2, 3, 4, 6, 8, 16, 32]) {
      const input = save(memory);
      const valid = [2, 4, 8].includes(memory);
      expect(isSupportedProfileMemory(memory)).toBe(valid);
      expect(fingerprintError(input.fingerprint) === null).toBe(valid);
      expect(saveProfileSchema.safeParse(input).success).toBe(valid);
      expect(saveProfileSchema.safeParse({ ...input, id }).success).toBe(valid);
      expect(bulkCreateSchema.safeParse({ teamId: id, prefix: "Audit", count: 1, folder: "", fingerprints: [input.fingerprint] }).success).toBe(valid);
      expect(bulkUpdateSchema.safeParse({ teamId: id, ids: [id], changes: { fingerprint: { deviceMemory: memory } } }).success).toBe(valid);
    }
    for (const value of [undefined, null, "4", NaN, Infinity]) expect(isSupportedProfileMemory(value)).toBe(false);
  });
  test("stored legacy settings stay readable and are never silently migrated", () => {
    for (const memory of [0.25, 0.5, 1, 16, 32]) {
      const legacy = { ...fp, deviceMemory: memory };
      expect(fingerprintSchema.parse(legacy).deviceMemory).toBe(memory);
      expect(profileFingerprintPayload(legacy).deviceMemory).toBe(memory);
      expect(legacy.deviceMemory).toBe(memory);
    }
    expect(bulkUpdateSchema.safeParse({ teamId: id, ids: [id], changes: { notes: "Unrelated change" } }).success).toBe(true);
    expect(bulkUpdateSchema.safeParse({ teamId: id, ids: [id], changes: { fingerprint: { timezone: "UTC" } } }).success).toBe(true);
  });
});
