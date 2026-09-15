import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { acceptInviteSchema, accessSchema, bulkAccessSchema, inviteIdSchema, inviteSchema, memberSchema, teamSchema, workspaceSchema } from "./server-validation";
import { callServerRpc, requireProfile, requireTeamOwner, type ServerContext } from "./server-db";

export type Workspace = {
  teamId: string;
  teamName: string;
  role: "owner" | "member";
  userId: string;
  email: string;
};

async function readWorkspaces(context: ServerContext): Promise<Workspace[]> {
  await callServerRpc(context.supabase, "ensure_workspace", {});
  const { data: me, error: personError } = await context.supabase.from("profiles").select("email").eq("id", context.userId).single();
  if (personError) throw new Error(personError.message);
  const { data: teams, error } = await context.supabase.from("teams").select("id, name, owner_id").order("created_at").order("id");
  if (error) throw new Error(error.message);
  return (teams ?? []).map((team) => ({
    teamId: team.id, teamName: team.name, role: team.owner_id === context.userId ? "owner" : "member",
    userId: context.userId, email: me.email ?? "",
  }));
}

export const listWorkspaces = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => readWorkspaces(context));

export const getWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(workspaceSchema)
  .handler(async ({ data, context }): Promise<Workspace> => {
    const teams = await readWorkspaces(context);
    const team = data?.teamId ? teams.find((item) => item.teamId === data.teamId) : teams[0];
    if (!team) throw new Error("Команда недоступна");
    return team;
  });

export const listMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(teamSchema)
  .handler(async ({ data, context }) => {
    await requireTeamOwner(context, data.teamId);
    const { supabase } = context;
    const { data: members, error: memberError } = await supabase.from("team_members")
      .select("id, user_id, role, created_at").eq("team_id", data.teamId).order("created_at");
    if (memberError) throw new Error(memberError.message);
    const userIds = (members ?? []).map((member) => member.user_id);
    const { data: people, error: peopleError } = userIds.length
      ? await supabase.from("profiles").select("id, email, display_name").in("id", userIds)
      : { data: [], error: null };
    if (peopleError) throw new Error(peopleError.message);
    const byId = new Map((people ?? []).map((person) => [person.id, person]));
    const { data: invites, error: inviteError } = await supabase.from("team_invites")
      .select("id, email, token, expires_at, accepted_at, created_at").eq("team_id", data.teamId)
      .is("accepted_at", null).order("created_at", { ascending: false });
    if (inviteError) throw new Error(inviteError.message);
    const { data: profiles, error: profileError } = await supabase.from("browser_profiles").select("id").eq("team_id", data.teamId);
    if (profileError) throw new Error(profileError.message);
    const profileIds = (profiles ?? []).map((profile) => profile.id);
    const { data: access, error: accessError } = profileIds.length
      ? await supabase.from("profile_access").select("profile_id, user_id").in("profile_id", profileIds)
      : { data: [], error: null };
    if (accessError) throw new Error(accessError.message);
    return {
      members: (members ?? []).map((member) => ({
        id: member.id, userId: member.user_id, role: member.role,
        email: byId.get(member.user_id)?.email ?? "", name: byId.get(member.user_id)?.display_name ?? "",
        createdAt: member.created_at,
      })),
      invites: invites ?? [], access: access ?? [],
    };
  });

export const createInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(inviteSchema)
  .handler(async ({ data, context }) => {
    await requireTeamOwner(context, data.teamId);
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const { data: row, error } = await context.supabase.from("team_invites").insert({
      team_id: data.teamId, email: data.email, invited_by: context.userId, token, role: "member",
    }).select("id, token, email, expires_at").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const revokeInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(inviteIdSchema)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("team_invites").delete().eq("id", data.inviteId).select("id").single();
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const removeMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(memberSchema)
  .handler(async ({ data, context }) => {
    await callServerRpc(context.supabase, "remove_team_member", { _team_id: data.teamId, _user_id: data.userId });
    return { ok: true };
  });

export const acceptInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(acceptInviteSchema)
  .handler(async ({ data, context }) => ({
    teamId: await callServerRpc(context.supabase, "accept_team_invite", { _token: data.token }),
  }));

export const setProfileAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(accessSchema)
  .handler(async ({ data, context }) => {
    const profile = await requireProfile(context, data.profileId, true);
    await callServerRpc(context.supabase, "set_profiles_access", {
      _team_id: profile.team_id, _profile_ids: [profile.id], _user_id: data.userId, _granted: data.granted,
    });
    return { ok: true };
  });

export const setProfilesAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(bulkAccessSchema)
  .handler(async ({ data, context }) => ({
    updated: await callServerRpc(context.supabase, "set_profiles_access", {
      _team_id: data.teamId, _profile_ids: data.profileIds, _user_id: data.userId, _granted: data.granted,
    }),
  }));

export const listAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(teamSchema)
  .handler(async ({ data, context }) => {
    await requireTeamOwner(context, data.teamId);
    const { data: rows, error } = await context.supabase.from("audit_log")
      .select("id, action, target_type, target_id, meta, created_at, user_id").eq("team_id", data.teamId)
      .order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    const ids = [...new Set((rows ?? []).flatMap((row) => row.user_id ? [row.user_id] : []))];
    const { data: people, error: peopleError } = ids.length
      ? await context.supabase.from("profiles").select("id, email").in("id", ids)
      : { data: [], error: null };
    if (peopleError) throw new Error(peopleError.message);
    const byId = new Map((people ?? []).map((person) => [person.id, person.email]));
    return (rows ?? []).map((row) => ({ ...row, email: byId.get(row.user_id ?? "") ?? "" }));
  });
