import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { browserSettingsSchema } from "./browser-settings";
import { serverDb } from "./server-db";

const inputSchema = browserSettingsSchema.omit({ updatedAt: true });

function parseRow(row: Record<string, unknown>) {
  return browserSettingsSchema.parse({
    profileId: row.profile_id, bookmarks: row.bookmarks,
    bookmarkBarVisible: row.bookmark_bar_visible, zoomLevel: row.zoom_level,
    extensions: row.extensions, revision: row.revision, updatedAt: row.updated_at,
  });
}

export const saveBrowserSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(inputSchema)
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase.rpc("save_profile_browser_settings", {
      _profile_id: data.profileId, _bookmarks: data.bookmarks,
      _bookmark_bar_visible: data.bookmarkBarVisible, _zoom_level: data.zoomLevel,
      _extensions: data.extensions, _expected_revision: data.revision,
    }).single();
    if (error) {
      if (error.code === "40001") throw new Error("Настройки изменились на другом компьютере");
      throw new Error("Не удалось сохранить настройки браузера");
    }
    return parseRow(row);
  });

export const fetchBrowserSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(browserSettingsSchema.pick({ profileId: true }))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await serverDb(context.supabase).from("profile_browser_settings").select("*").eq("profile_id", data.profileId).maybeSingle();
    if (error) throw new Error("Не удалось загрузить настройки браузера");
    return row ? parseRow(row) : null;
  });