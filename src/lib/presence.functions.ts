import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { presenceSchema, teamSchema } from "./server-validation";
import { requireTeamManager } from "./server-db";

export type PresenceRow = {
  userId: string;
  email: string;
  name: string;
  role: "owner" | "member";
  scope: "owner" | "manager" | "member";
  lastSeenAt: string | null;
  deviceLabel: string | null;
  activeProfileId: string | null;
  activeProfileName: string;
};

export const touchPresence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(presenceSchema)
  .handler(async ({ data, context }) => {
    const args = {
      _team_id: data.teamId,
      ...(data.profileId ? { _profile_id: data.profileId } : {}),
      ...(data.deviceLabel ? { _device_label: data.deviceLabel } : {}),
    };
    const { error } = await context.supabase.rpc("touch_presence", args);
    if (error) throw new Error("Не удалось отметить активность");
    return { ok: true };
  });

export const listPresence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(teamSchema)
  .handler(async ({ data, context }): Promise<PresenceRow[]> => {
    await requireTeamManager(context, data.teamId);
    const { supabase } = context;
    const { data: members, error } = await supabase
      .from("team_members").select("user_id, role, scope").eq("team_id", data.teamId).order("created_at");
    if (error) throw new Error("Не удалось загрузить сотрудников");
    const userIds = (members ?? []).map((member) => member.user_id);
    if (!userIds.length) return [];

    const [{ data: people }, { data: presence }, { data: locks }] = await Promise.all([
      supabase.from("profiles").select("id, email, display_name").in("id", userIds),
      supabase.from("user_presence").select("user_id, last_seen_at, active_profile_id, device_label").eq("team_id", data.teamId),
      supabase.from("profile_locks").select("profile_id, user_id, expires_at, device_label"),
    ]);

    const now = Date.now();
    const liveLocks = (locks ?? []).filter((lock) => new Date(lock.expires_at).getTime() > now);
    const profileIds = [...new Set(liveLocks.map((lock) => lock.profile_id))];
    const { data: profileNames } = profileIds.length
      ? await supabase.from("browser_profiles").select("id, name").in("id", profileIds)
      : { data: [] };

    const byUser = new Map((people ?? []).map((person) => [person.id, person]));
    const presenceByUser = new Map((presence ?? []).map((row) => [row.user_id, row]));
    const lockByUser = new Map(liveLocks.map((lock) => [lock.user_id, lock]));
    const nameById = new Map((profileNames ?? []).map((row) => [row.id, row.name]));

    return (members ?? []).map((member) => {
      const seen = presenceByUser.get(member.user_id);
      const lock = lockByUser.get(member.user_id);
      const activeProfileId = lock?.profile_id ?? null;
      return {
        userId: member.user_id,
        email: byUser.get(member.user_id)?.email ?? "",
        name: byUser.get(member.user_id)?.display_name ?? "",
        role: member.role === "owner" ? "owner" as const : "member" as const,
        scope: member.role === "owner" ? "owner" as const : (member as { scope?: string }).scope === "manager" ? "manager" as const : "member" as const,
        lastSeenAt: seen?.last_seen_at ?? null,
        deviceLabel: lock?.device_label ?? seen?.device_label ?? null,
        activeProfileId,
        activeProfileName: activeProfileId ? nameById.get(activeProfileId) ?? "профиль" : "",
      };
    });
  });
