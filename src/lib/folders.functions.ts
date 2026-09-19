import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { folderAccessSchema, teamSchema, transferSchema } from "./server-validation";
import { callServerRpc, requireTeamManager } from "./server-db";

export type FolderAccessRow = { folder: string; userId: string };

export const listFolderAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(teamSchema)
  .handler(async ({ data, context }): Promise<FolderAccessRow[]> => {
    await requireTeamManager(context, data.teamId);
    const { data: rows, error } = await context.supabase
      .from("folder_access")
      .select("folder, user_id")
      .eq("team_id", data.teamId);
    if (error) throw new Error(error.message);
    return (rows ?? []).map((row) => ({ folder: row.folder as string, userId: row.user_id as string }));
  });

export const setFolderAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(folderAccessSchema)
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
    await callServerRpc(context.supabase, "set_folder_access", {
      _team_id: data.teamId, _folder: data.folder, _user_id: data.userId, _granted: data.granted,
    });
    return { ok: true };
  });

export const transferProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(transferSchema)
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
    const moved = await callServerRpc(context.supabase, "transfer_profiles", {
      _team_id: data.teamId,
      _profile_ids: data.profileIds,
      _folder: data.folder ?? null,
      _user_id: data.userId ?? null,
    });
    return { moved };
  });
