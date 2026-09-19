import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { acceptInviteSchema, inviteIdSchema, inviteSchema, employeeSchema, memberSchema, teamSchema, updateEmployeeSchema, workspaceSchema } from "./server-validation";
import { callServerRpc, isSuperadmin, memberPermissions, requireTeamManager, PERMISSION_KEYS, type Permission, type PermissionMap, type ServerContext, type TeamScope } from "./server-db";
import { z } from "zod";

export type Workspace = {
  teamId: string;
  teamName: string;
  role: "owner" | "member";
  scope: TeamScope;
  canManage: boolean;
  userId: string;
  email: string;
  isSuperadmin: boolean;
};

async function readWorkspaces(context: ServerContext): Promise<Workspace[]> {
  // Старый клиент мог открыть панель раньше, чем Lovable Cloud применил все
  // миграции. Существующая команда при этом должна оставаться доступной.
  let bootstrapFailed = false;
  try { await callServerRpc(context.supabase, "ensure_workspace", {}); }
  catch { bootstrapFailed = true; }
  const { data: me } = await context.supabase.from("profiles").select("email").eq("id", context.userId).maybeSingle();
  const { data: teams, error } = await context.supabase.from("teams").select("id, name, owner_id").order("created_at").order("id");
  if (error) throw new Error("Не удалось загрузить рабочее пространство");
  if (!(teams ?? []).length && bootstrapFailed) throw new Error("Не удалось подготовить рабочее пространство");
  let { data: memberships, error: membershipError } = await context.supabase.from("team_members").select("team_id, scope").eq("user_id", context.userId);
  if (membershipError) {
    const legacy = await context.supabase.from("team_members").select("team_id").eq("user_id", context.userId);
    if (legacy.error) throw new Error("Не удалось загрузить доступ к команде");
    memberships = (legacy.data ?? []).map((row) => ({ ...row, scope: "member" }));
    membershipError = null;
  }
  const scopeByTeam = new Map((memberships ?? []).map((row) => [row.team_id, (row as { scope?: string }).scope === "manager" ? "manager" : "member"] as const));
  const superadmin = await isSuperadmin(context);
  return (teams ?? []).map((team) => {
    const owner = superadmin || team.owner_id === context.userId;
    const scope: TeamScope = owner ? "owner" : (scopeByTeam.get(team.id) ?? "member");
    return {
      teamId: team.id, teamName: team.name, role: owner ? "owner" as const : "member" as const,
      scope, canManage: scope !== "member", userId: context.userId, email: me?.email ?? "", isSuperadmin: superadmin,
    };
  });
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
    await requireTeamManager(context, data.teamId);
    const { supabase } = context;
    const { data: members, error: memberError } = await supabase.from("team_members")
      .select("id, user_id, role, scope, created_at").eq("team_id", data.teamId).order("created_at");
    if (memberError) throw new Error(memberError.message);
    const userIds = (members ?? []).map((member) => member.user_id);
    const { data: people, error: peopleError } = userIds.length
      ? await supabase.from("profiles").select("id, email, display_name").in("id", userIds)
      : { data: [], error: null };
    if (peopleError) throw new Error(peopleError.message);
    const byId = new Map((people ?? []).map((person) => [person.id, person]));
    // Суперадминистратор всегда показывается как владелец с полным доступом.
    const superIds = new Set<string>();
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (name: string) => PromiseLike<{ data: unknown }>;
      const { data: supers } = await rpc("superadmin_ids");
      for (const row of (supers ?? []) as Array<string | { superadmin_ids?: string }>) {
        const id = typeof row === "string" ? row : row?.superadmin_ids;
        if (id) superIds.add(id);
      }
    } catch { /* старая база без суперадминов */ }
    const { data: invites, error: inviteError } = await supabase.from("team_invites")
      .select("id, email, token, expires_at, accepted_at, created_at").eq("team_id", data.teamId)
      .is("accepted_at", null).order("created_at", { ascending: false });
    if (inviteError) throw new Error(inviteError.message);
    return {
      members: (members ?? []).map((member) => ({
        id: member.id, userId: member.user_id,
        role: superIds.has(member.user_id) ? "owner" as const : member.role,
        scope: superIds.has(member.user_id) ? "owner" as const
          : (member as { scope?: string }).scope === "manager" ? "manager" as const : "member" as const,
        email: byId.get(member.user_id)?.email ?? (superIds.has(member.user_id) ? "mafiatrafa@umbra.app" : ""),
        name: byId.get(member.user_id)?.display_name ?? (superIds.has(member.user_id) ? "mafiatrafa" : ""),
        createdAt: member.created_at,
      })),
      invites: invites ?? [],
    };
  });

export const createInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(inviteSchema)
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
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

// Доступ к профилям выдаётся только через папки. Точечная выдача прав на
// отдельный профиль убрана намеренно.
export const getMyPermissions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(teamSchema)
  .handler(async ({ data, context }): Promise<PermissionMap & { scope: TeamScope | null }> =>
    memberPermissions(context, data.teamId));

export const listMemberPermissions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(teamSchema)
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
    const { data: rows, error } = await context.supabase.from("member_permissions" as never)
      .select("*").eq("team_id", data.teamId);
    if (error) throw new Error("Не удалось загрузить права сотрудников");
    return ((rows ?? []) as Record<string, unknown>[]).map((row) => ({
      userId: String(row["user_id"]),
      "profile.create": row["can_create_profile"] === true,
      "profile.edit": row["can_edit_profile"] === true,
      "profile.delete": row["can_delete_profile"] === true,
      "profile.proxy": row["can_change_profile_proxy"] === true,
      "folder.manage": row["can_manage_folders"] === true,
      "proxy.manage": row["can_manage_proxies"] === true,
      "bookmarks.manage": row["can_manage_bookmarks"] === true,
    }));
  });

export const setMemberPermissions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({
    teamId: z.string().uuid(), userId: z.string().uuid(),
    permissions: z.object(Object.fromEntries(PERMISSION_KEYS.map((key) => [key, z.boolean()])) as Record<(typeof PERMISSION_KEYS)[number], z.ZodBoolean>).strict(),
  }).strict().parse(input))
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
    await callServerRpc(context.supabase, "set_member_permissions", {
      _team_id: data.teamId, _user_id: data.userId,
      _create: data.permissions["profile.create"], _edit: data.permissions["profile.edit"],
      _delete: data.permissions["profile.delete"], _proxy: data.permissions["profile.proxy"],
      _folders: data.permissions["folder.manage"], _proxies: data.permissions["proxy.manage"],
      _bookmarks: data.permissions["bookmarks.manage"],
    });
    return { ok: true };
  });

export const setMemberScope = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ teamId: z.string().uuid(), userId: z.string().uuid(), scope: z.enum(["member", "manager"]) }).strict().parse(input))
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
    await callServerRpc(context.supabase, "set_member_scope", { _team_id: data.teamId, _user_id: data.userId, _scope: data.scope });
    return { ok: true };
  });

export const listAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(teamSchema)
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
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

export const createEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(employeeSchema)
  .handler(async ({ data, context }) => {
    if (!(await isSuperadmin(context))) throw new Error("Создавать учётные записи может только суперадминистратор");
    await requireTeamManager(context, data.teamId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const created = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: data.displayName ? { display_name: data.displayName } : {},
    });
    if (created.error || !created.data.user) {
      const message = created.error?.message ?? "";
      if (/already/i.test(message)) throw new Error("Такая почта уже зарегистрирована");
      if (/weak|guess|pwned|password/i.test(message)) {
        throw new Error("Пароль слишком простой или встречался в утечках. Придумайте уникальный пароль из 12 и более символов с буквами, цифрами и знаками");
      }
      throw new Error("Не удалось создать учётную запись. Повторите попытку");
    }
    const userId = created.data.user.id;
    await supabaseAdmin.from("profiles").upsert({
      id: userId, email: data.email, ...(data.displayName ? { display_name: data.displayName } : {}),
    });
    const { error } = await supabaseAdmin.from("team_members")
      .insert({ team_id: data.teamId, user_id: userId, role: "member", scope: "member" });
    if (error) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      throw new Error("Не удалось добавить учётную запись в команду");
    }
    await context.supabase.from("audit_log").insert({
      team_id: data.teamId, user_id: context.userId, action: "employee.created",
      target_type: "user", target_id: userId,
    });
    return { userId, email: data.email };
  });

async function requireManagedEmployee(context: ServerContext, teamId: string, userId: string) {
  if (!(await isSuperadmin(context))) throw new Error("Доступ только для владельца Umbra");
  if (userId === context.userId) throw new Error("Учётную запись владельца изменить нельзя");
  const { data, error } = await context.supabase.from("team_members")
    .select("user_id, role").eq("team_id", teamId).eq("user_id", userId).maybeSingle();
  if (error || !data || data.role === "owner") throw new Error("Сотрудник не найден");
}

export const updateEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(updateEmployeeSchema)
  .handler(async ({ data, context }) => {
    await requireManagedEmployee(context, data.teamId, data.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const authUpdate: { email: string; password?: string; user_metadata: { display_name: string } } = {
      email: data.email,
      user_metadata: { display_name: data.displayName },
      ...(data.password ? { password: data.password } : {}),
    };
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(data.userId, authUpdate);
    if (authError) {
      if (/already/i.test(authError.message)) throw new Error("Такая почта уже зарегистрирована");
      if (/weak|guess|pwned|password/i.test(authError.message)) {
        throw new Error("Новый пароль слишком простой или встречался в утечках. Используйте уникальный пароль из 12 и более символов");
      }
      throw new Error("Не удалось изменить учётную запись");
    }
    const { error: profileError } = await supabaseAdmin.from("profiles").upsert({
      id: data.userId, email: data.email, display_name: data.displayName,
    });
    if (profileError) throw new Error("Данные входа изменены, но имя не удалось обновить");
    await context.supabase.from("audit_log").insert({
      team_id: data.teamId, user_id: context.userId, action: "employee.updated",
      target_type: "user", target_id: data.userId,
    });
    return { ok: true };
  });

export const revokeEmployeeAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(memberSchema)
  .handler(async ({ data, context }) => {
    await requireManagedEmployee(context, data.teamId, data.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const results = await Promise.all([
      supabaseAdmin.from("member_permissions").delete().eq("team_id", data.teamId).eq("user_id", data.userId),
      supabaseAdmin.from("folder_access").delete().eq("team_id", data.teamId).eq("user_id", data.userId),
      supabaseAdmin.from("profile_access").delete().eq("user_id", data.userId),
      supabaseAdmin.from("team_members").update({ scope: "member" }).eq("team_id", data.teamId).eq("user_id", data.userId),
    ]);
    if (results.some((result) => result.error)) throw new Error("Не удалось полностью забрать доступы");
    await context.supabase.from("audit_log").insert({
      team_id: data.teamId, user_id: context.userId, action: "employee.access_revoked",
      target_type: "user", target_id: data.userId,
    });
    return { ok: true };
  });

export const deleteEmployeeAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(memberSchema)
  .handler(async ({ data, context }) => {
    await requireManagedEmployee(context, data.teamId, data.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error("Не удалось удалить учётную запись сотрудника");
    await context.supabase.from("audit_log").insert({
      team_id: data.teamId, user_id: context.userId, action: "employee.deleted",
      target_type: "user", target_id: data.userId,
    });
    return { ok: true };
  });
