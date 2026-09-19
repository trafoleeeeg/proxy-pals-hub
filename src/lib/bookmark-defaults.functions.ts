import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { bookmarkDefaultsSchema, DEFAULT_TEAM_BOOKMARKS } from "./bookmark-defaults";
import { callServerRpc, requirePermission, requireTeamAccess } from "./server-db";
import { z } from "zod";

const teamInput = z.object({ teamId: z.string().uuid() }).strict();
const saveInput = bookmarkDefaultsSchema.pick({ teamId: true, bookmarks: true, bookmarkBarVisible: true });

function fallback(teamId: string) {
  return bookmarkDefaultsSchema.parse({
    teamId,
    bookmarks: DEFAULT_TEAM_BOOKMARKS,
    bookmarkBarVisible: true,
    revision: 0,
    updatedAt: null,
  });
}

export const getBookmarkDefaults = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(teamInput)
  .handler(async ({ data, context }) => {
    await requireTeamAccess(context, data.teamId);
    const raw = await callServerRpc(context.supabase, "get_team_bookmark_defaults", { _team_id: data.teamId });
    const parsed = bookmarkDefaultsSchema.parse(raw);
    return parsed.revision === 0 && parsed.bookmarks.length === 0 ? fallback(data.teamId) : parsed;
  });

export const saveBookmarkDefaults = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(saveInput)
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "bookmarks.manage");
    const raw = await callServerRpc(context.supabase, "save_team_bookmark_defaults", {
      _team_id: data.teamId,
      _bookmarks: data.bookmarks,
      _bookmark_bar_visible: data.bookmarkBarVisible,
    });
    return bookmarkDefaultsSchema.parse(raw);
  });
