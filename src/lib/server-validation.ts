import { z } from "zod";

export const uuidSchema = z.string().uuid();
const text = (max: number) => z.string().max(max).regex(/^[^\0]*$/, "Invalid text");
export const teamSchema = z.object({ teamId: uuidSchema }).strict();
export const profileIdSchema = z.object({ profileId: uuidSchema }).strict();
export const idSchema = z.object({ id: uuidSchema }).strict();
export const profileIdsSchema = z.array(uuidSchema).min(1).max(200)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate profile IDs");
const language = text(64).min(2).refine((value) => {
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
}, "Invalid language");
const timezone = text(100).min(1).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Invalid timezone");
const startUrl = text(4096).url().refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "Only HTTP(S) URLs without credentials are allowed");

export const fingerprintSchema = z.object({
  os: z.literal("windows"),
  osVersion: text(32).min(1),
  chromeVersion: z.string().regex(/^\d{1,4}(\.\d{1,6}){0,3}$/),
  userAgent: text(1024).min(1).refine((s) => !/[\r\n]/.test(s), "Invalid user agent"),
  platform: text(64).min(1),
  screen: z.object({ width: z.number().int().min(320).max(16384), height: z.number().int().min(240).max(16384), colorDepth: z.number().int().min(8).max(48) }).strict(),
  gpu: z.object({ vendor: text(256), renderer: text(1024) }).strict(),
  hardwareConcurrency: z.number().int().min(1).max(128),
  deviceMemory: z.number().finite().min(0.25).max(128),
  language,
  languages: z.array(language).min(1).max(16),
  timezone,
  fontsPreset: text(256),
  canvasNoise: z.number().int().min(0).max(2147483647),
  webglNoise: z.number().int().min(0).max(2147483647),
  audioNoise: z.number().int().min(0).max(2147483647),
  webrtc: z.enum(["disabled", "proxy"]),
  doNotTrack: z.boolean(),
  startUrl: startUrl.optional(),
}).strict();

const folder = text(200).trim();
const tags = z.array(text(80).trim().min(1)).max(50);
const notes = text(20000);
const customFields = z.record(uuidSchema, text(2000)).refine((value) => Object.keys(value).length <= 50, "Too many custom fields");
export const saveProfileSchema = z.object({
  id: uuidSchema.optional(), teamId: uuidSchema, name: text(200).trim().min(1),
  folder, tags, notes, proxyId: uuidSchema.nullable(), fingerprint: fingerprintSchema,
  statusId: uuidSchema.nullable().optional(), customFields: customFields.optional(),
}).strict();
export const bulkCreateSchema = z.object({
  teamId: uuidSchema, prefix: text(180).trim().min(1), count: z.number().int().min(1).max(200),
  folder, fingerprints: z.array(fingerprintSchema).min(1).max(200),
}).strict().refine((d) => d.count === d.fingerprints.length, "Fingerprint count must match count");
export const bulkUpdateSchema = z.object({
  teamId: uuidSchema, ids: profileIdsSchema,
  changes: z.object({ folder: folder.optional(), tags: tags.optional(), notes: notes.optional(),
    proxyId: uuidSchema.nullable().optional(), fingerprint: fingerprintSchema.partial().strict().optional(),
  }).strict().refine((d) => Object.values(d).some((v) => v !== undefined), "No changes"),
}).strict();
export const bulkDeleteSchema = z.object({ teamId: uuidSchema, ids: profileIdsSchema }).strict();
export const cookiesTextSchema = z.string().max(5_000_000);
export const importCookiesSchema = z.object({ profileId: uuidSchema, text: cookiesTextSchema }).strict();
const deviceId = text(200).trim().min(1);
export const launchSchema = z.object({ profileId: uuidSchema, device: text(200).optional(), deviceId: deviceId.optional() }).strict();
export const leaseSchema = z.object({ profileId: uuidSchema, lockToken: uuidSchema.optional(), deviceId: deviceId.optional() }).strict();
export const saveSessionSchema = leaseSchema.extend({ cookies: cookiesTextSchema });
export const closeSessionSchema = leaseSchema.extend({ cookies: cookiesTextSchema.optional() });
export const workspaceSchema = z.object({ teamId: uuidSchema.optional() }).strict().optional();
export const inviteSchema = z.object({ teamId: uuidSchema, email: z.string().trim().toLowerCase().email().max(254) }).strict();
export const inviteIdSchema = z.object({ inviteId: uuidSchema }).strict();
export const acceptInviteSchema = z.object({ token: z.string().trim().regex(/^[a-fA-F0-9]{64}$/) }).strict();
export const memberSchema = z.object({ teamId: uuidSchema, userId: uuidSchema }).strict();
export const accessSchema = z.object({ profileId: uuidSchema, userId: uuidSchema, granted: z.boolean() }).strict();
export const bulkAccessSchema = z.object({ teamId: uuidSchema, profileIds: profileIdsSchema, userId: uuidSchema, granted: z.boolean() }).strict();
