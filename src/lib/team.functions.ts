import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type Workspace = {
  teamId: string;
  teamName: string;
  role: "owner" | "member";
  userId: string;
  email: string;
};

/** Возвращает команду пользователя. Владельцу создаёт её при первом входе. */
export const getWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Workspace> => {
    const { supabase, userId } = context;
    let email = (context.claims?.["email"] as string) ?? "";
    if (!email) {
      const { data: me } = await supabase.from("profiles").select("email").eq("id", userId).maybeSingle();
      email = me?.email ?? "";
    }

    const { data: membership } = await supabase
      .from("team_members")
      .select("team_id, role, teams(name)")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (membership) {
      return {
        teamId: membership.team_id,
        teamName: (membership as never as { teams?: { name?: string } }).teams?.name ?? "Команда",
        role: membership.role as "owner" | "member",
        userId,
        email,
      };
    }

    const { data: team, error: teamErr } = await supabase
      .from("teams")
      .insert({ owner_id: userId, name: "Моя команда" })
      .select("id, name")
      .single();
    if (teamErr) throw new Error(teamErr.message);

    const { error: memberErr } = await supabase
      .from("team_members")
      .insert({ team_id: team.id, user_id: userId, role: "owner" });
    if (memberErr) throw new Error(memberErr.message);

    return { teamId: team.id, teamName: team.name, role: "owner", userId, email };
  });

export const listMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: me } = await supabase
      .from("team_members")
      .select("role")
      .eq("team_id", data.teamId)
      .eq("user_id", userId)
      .maybeSingle();
    if (me?.role !== "owner") throw new Error("Доступ только для владельца");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: members } = await supabaseAdmin
      .from("team_members")
      .select("id, user_id, role, created_at, profiles:user_id(email, display_name)")
      .eq("team_id", data.teamId)
      .order("created_at");

    const { data: invites } = await supabaseAdmin
      .from("team_invites")
      .select("id, email, token, expires_at, accepted_at, created_at")
      .eq("team_id", data.teamId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false });

    const { data: access } = await supabaseAdmin
      .from("profile_access")
      .select("profile_id, user_id")
      .in("user_id", (members ?? []).map((m) => m.user_id));

    return {
      members: (members ?? []).map((m) => ({
        id: m.id,
        userId: m.user_id,
        role: m.role as "owner" | "member",
        email:
          (m as never as { profiles?: { email?: string } }).profiles?.email ?? "—",
        name:
          (m as never as { profiles?: { display_name?: string } }).profiles?.display_name ?? "",
        createdAt: m.created_at,
      })),
      invites: invites ?? [],
      access: access ?? [],
    };
  });

export const createInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string; email: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const { data: row, error } = await supabase
      .from("team_invites")
      .insert({
        team_id: data.teamId,
        email: data.email.trim().toLowerCase(),
        invited_by: userId,
        token,
      })
      .select("id, token, email, expires_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const revokeInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { inviteId: string }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("team_invites").delete().eq("id", data.inviteId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const removeMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string; userId: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("team_members")
      .delete()
      .eq("team_id", data.teamId)
      .eq("user_id", data.userId);
    if (error) throw new Error(error.message);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: teamProfiles } = await supabaseAdmin
      .from("browser_profiles")
      .select("id")
      .eq("team_id", data.teamId);
    await supabaseAdmin
      .from("profile_access")
      .delete()
      .eq("user_id", data.userId)
      .in("profile_id", (teamProfiles ?? []).map((p) => p.id));
    return { ok: true };
  });

/** Принять приглашение по коду — вызывается уже вошедшим пользователем. */
export const acceptInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: invite } = await supabaseAdmin
      .from("team_invites")
      .select("id, team_id, email, expires_at, accepted_at")
      .eq("token", data.token.trim())
      .maybeSingle();

    if (!invite) throw new Error("Приглашение не найдено");
    if (invite.accepted_at) throw new Error("Приглашение уже использовано");
    if (new Date(invite.expires_at) < new Date()) throw new Error("Срок приглашения истёк");

    const email = ((context.claims?.["email"] as string) ?? "").toLowerCase();
    if (email && invite.email && email !== invite.email)
      throw new Error("Приглашение выписано на другой email");

    await supabaseAdmin
      .from("team_members")
      .upsert({ team_id: invite.team_id, user_id: userId, role: "member" }, { onConflict: "team_id,user_id" });
    await supabaseAdmin.from("team_invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);
    await supabaseAdmin.from("audit_log").insert({
      team_id: invite.team_id,
      user_id: userId,
      action: "member.joined",
      target_type: "member",
      meta: { email },
    });
    return { teamId: invite.team_id };
  });

export const setProfileAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string; userId: string; granted: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.granted) {
      const { error } = await supabase
        .from("profile_access")
        .upsert(
          { profile_id: data.profileId, user_id: data.userId, granted_by: userId },
          { onConflict: "profile_id,user_id" },
        );
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase
        .from("profile_access")
        .delete()
        .eq("profile_id", data.profileId)
        .eq("user_id", data.userId);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const listAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("audit_log")
      .select("id, action, target_type, target_id, meta, created_at, user_id")
      .eq("team_id", data.teamId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const ids = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
    const { data: people } = ids.length
      ? await supabaseAdmin.from("profiles").select("id, email").in("id", ids)
      : { data: [] };
    const byId = new Map((people ?? []).map((p) => [p.id, p.email]));
    return (rows ?? []).map((r) => ({ ...r, email: byId.get(r.user_id ?? "") ?? "—" }));
  });
