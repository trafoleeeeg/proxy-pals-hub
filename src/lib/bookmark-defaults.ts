import { z } from "zod";
import { bookmarkSchema } from "./browser-settings";

export const DEFAULT_TEAM_BOOKMARKS = [
  { id: "10000000-0000-4000-8000-000000000001", title: "Facebook", url: "https://www.facebook.com/" },
  { id: "10000000-0000-4000-8000-000000000002", title: "Facebook Ads", url: "https://adsmanager.facebook.com/adsmanager/manage/campaigns" },
  { id: "10000000-0000-4000-8000-000000000003", title: "Google Ads", url: "https://ads.google.com/aw/campaigns" },
  { id: "10000000-0000-4000-8000-000000000004", title: "TikTok Ads", url: "https://ads.tiktok.com/" },
  { id: "10000000-0000-4000-8000-000000000005", title: "Gmail", url: "https://mail.google.com/" },
] as const;

export const bookmarkDefaultsSchema = z.object({
  teamId: z.string().uuid(),
  bookmarks: z.array(bookmarkSchema).max(64),
  bookmarkBarVisible: z.boolean(),
  revision: z.number().int().min(0),
  updatedAt: z.string().datetime().nullable().optional(),
}).strict();

export type BookmarkDefaults = z.infer<typeof bookmarkDefaultsSchema>;
