import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { callServerRpc, requirePermission, requireTeamAccess } from "./server-db";
import { teamSchema } from "./server-validation";

export const listTrash = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(teamSchema)
  .handler(async ({ data, context }) => {
    await requireTeamAccess(context, data.teamId);
    return callServerRpc(context.supabase, "list_trashed_profiles", { _team_id: data.teamId });
  });

export const restoreProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ teamId: z.string().uuid(), profileId: z.string().uuid() }).strict().parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "profile.delete");
    await callServerRpc(context.supabase, "restore_trashed_profile", { _team_id: data.teamId, _profile_id: data.profileId });
    return { ok: true };
  });
