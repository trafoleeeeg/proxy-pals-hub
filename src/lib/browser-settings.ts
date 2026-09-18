import { z } from "zod";

const favicon = z.string().regex(/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/]+={0,2}$/i).max(90_000);

export const browserSettingsSchema = z.object({
  profileId: z.string().uuid(),
  bookmarks: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().max(120),
    url: z.string().url().refine((value) => /^https?:\/\//i.test(value), "Разрешены только HTTP(S)-ссылки"),
    favicon: favicon.optional(),
  }).strict()).max(64),
  bookmarkBarVisible: z.boolean(),
  zoomLevel: z.number().min(-3).max(5),
  extensions: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{24}$/),
    url: z.string().url().refine((value) => value.startsWith("https://"), "Разрешены только HTTPS-ссылки"),
    pinned: z.boolean(),
  }).strict()).max(64),
  revision: z.number().int().min(0),
  updatedAt: z.string().datetime().optional(),
}).strict();

export type BrowserSettings = z.infer<typeof browserSettingsSchema>;
