import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Rpc<Args, Returns> = { Args: Args; Returns: Returns };
type LeaseResult = { lockToken: string; expiresAt: string; cookiesUpdatedAt: string };
type MigrationFunctions = {
  acquire_profile_lease: Rpc<{ _profile_id: string; _device_id: string; _device_label: string | null }, LeaseResult>;
  mutate_profile_lease: Rpc<{ _profile_id: string; _lock_token: string; _operation: "save" | "heartbeat" | "close"; _cookies_enc: string | null; _device_id: string | null }, { expiresAt: string; cookiesUpdatedAt: string }>;
  force_profile_unlock: Rpc<{ _profile_id: string }, boolean>;
  import_profile_cookies: Rpc<{ _profile_id: string; _cookies_enc: string }, string>;
  bulk_mutate_profiles: Rpc<{ _team_id: string; _profile_ids: string[]; _operation: "update" | "delete"; _changes: Json }, number>;
  set_folder_access: Rpc<{ _team_id: string; _folder: string; _user_id: string; _granted: boolean }, boolean>;
  rename_team_folder: Rpc<{ _team_id: string; _folder_id: string; _name: string }, boolean>;
  delete_team_folder: Rpc<{ _team_id: string; _folder_id: string }, boolean>;
  reorder_team_folders: Rpc<{ _team_id: string; _folder_ids: string[] }, boolean>;
  prune_team_audit_log: Rpc<{ _team_id: string }, number>;
  list_trashed_profiles: Rpc<{ _team_id: string }, Array<{ id: string; name: string; folder: string; deleted_at: string }>>;
  restore_trashed_profile: Rpc<{ _team_id: string; _profile_id: string }, boolean>;
  trash_agent_profile: Rpc<{ _team_id: string; _profile_id: string }, boolean>;
  transfer_profiles: Rpc<{ _team_id: string; _profile_ids: string[]; _folder: string; _user_id: null }, number>;
  set_member_permissions: Rpc<{ _team_id: string; _user_id: string; _create: boolean; _edit: boolean; _delete: boolean; _proxy: boolean; _folders: boolean; _proxies: boolean; _bookmarks: boolean }, boolean>;
  remove_team_member: Rpc<{ _team_id: string; _user_id: string }, boolean>;
  set_member_scope: Rpc<{ _team_id: string; _user_id: string; _scope: "member" | "manager" }, boolean>;
  accept_team_invite: Rpc<{ _token: string }, string>;
  ensure_workspace: Rpc<Record<string, never>, string>;
  get_team_bookmark_defaults: Rpc<{ _team_id: string }, unknown>;
  save_team_bookmark_defaults: Rpc<{ _team_id: string; _bookmarks: Json; _bookmark_bar_visible: boolean }, unknown>;
};

// Local migration contract until Supabase regenerates its integration files.
type ServerDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions" | "Tables"> & {
    Functions: Database["public"]["Functions"] & MigrationFunctions;
    Tables: Omit<Database["public"]["Tables"], "browser_profiles" | "profile_folders"> & {
      browser_profiles: Omit<Database["public"]["Tables"]["browser_profiles"], "Row"> & {
        Row: Database["public"]["Tables"]["browser_profiles"]["Row"] & { cookies_updated_at: string };
      };
      profile_folders: Omit<Database["public"]["Tables"]["profile_folders"], "Row"> & {
        Row: Database["public"]["Tables"]["profile_folders"]["Row"] & { position: number };
      };
    };
  };
};
export function serverDb(client: SupabaseClient<Database>): SupabaseClient<ServerDatabase> {
  return client as unknown as SupabaseClient<ServerDatabase>;
}
export async function callServerRpc<K extends keyof MigrationFunctions>(client: SupabaseClient<Database>, name: K, args: MigrationFunctions[K]["Args"]): Promise<MigrationFunctions[K]["Returns"]> {
  // Isolate the generated-client mismatch; every caller uses the explicit RPC contract.
  const rpc = client.rpc.bind(client) as unknown as (name: K, args: MigrationFunctions[K]["Args"]) => PromiseLike<{ data: MigrationFunctions[K]["Returns"] | null; error: { message: string } | null }>;
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(error.message);
  if (data === null) throw new Error("Server operation returned no result");
  return data;
}

export type ServerContext = { supabase: SupabaseClient<Database>; userId: string };
// Суперадминистратор приравнивается к владельцу в любой команде.
export async function isSuperadmin(context: ServerContext): Promise<boolean> {
  const rpc = context.supabase.rpc.bind(context.supabase) as unknown as (name: string) => PromiseLike<{ data: boolean | null; error: { message: string } | null }>;
  try {
    const { data } = await rpc("is_superadmin");
    return data === true;
  } catch {
    return false;
  }
}
export async function requireTeamOwner(context: ServerContext, teamId: string) {
  const { data, error } = await context.supabase.from("teams").select("id, owner_id").eq("id", teamId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Доступ только для владельца команды");
  if (data.owner_id !== context.userId && !(await isSuperadmin(context))) throw new Error("Доступ только для владельца команды");
  return data;
}
export type TeamScope = "owner" | "manager" | "member";
// Владелец управляет командой и секретами, администратор — профилями и прокси,
// участник работает только с назначенными профилями.
export async function teamScope(context: ServerContext, teamId: string): Promise<TeamScope | null> {
  const { data: team, error: teamError } = await context.supabase.from("teams").select("owner_id").eq("id", teamId).maybeSingle();
  if (teamError) throw new Error("Не удалось проверить доступ к команде: " + teamError.message);
  if (!team) return null;
  if (team.owner_id === context.userId) return "owner";
  if (await isSuperadmin(context)) return "owner";
  const { data: member, error: memberError } = await context.supabase.from("team_members").select("scope")
    .eq("team_id", teamId).eq("user_id", context.userId).maybeSingle();
  if (memberError) throw new Error("Не удалось проверить участие в команде: " + memberError.message);
  if (!member) return null;
  return (member as { scope?: string }).scope === "manager" ? "manager" : "member";
}
export const PERMISSION_KEYS = [
  "profile.create", "profile.edit", "profile.delete", "profile.proxy",
  "folder.manage", "proxy.manage", "bookmarks.manage",
] as const;
export type Permission = (typeof PERMISSION_KEYS)[number];
export type PermissionMap = Record<Permission, boolean>;
export const NO_PERMISSIONS: PermissionMap = {
  "profile.create": false, "profile.edit": false, "profile.delete": false, "profile.proxy": false,
  "folder.manage": false, "proxy.manage": false, "bookmarks.manage": false,
};
const PERMISSION_COLUMNS: Record<Permission, string> = {
  "profile.create": "can_create_profile", "profile.edit": "can_edit_profile",
  "profile.delete": "can_delete_profile", "profile.proxy": "can_change_profile_proxy",
  "folder.manage": "can_manage_folders", "proxy.manage": "can_manage_proxies",
  "bookmarks.manage": "can_manage_bookmarks",
};

// Владелец и администратор команды обладают всеми правами; остальным права
// выдаёт владелец точечно в разделе «Команда».
export async function memberPermissions(context: ServerContext, teamId: string): Promise<PermissionMap & { scope: TeamScope | null }> {
  const scope = await teamScope(context, teamId);
  if (!scope) return { ...NO_PERMISSIONS, scope: null };
  if (scope !== "member") {
    return { ...NO_PERMISSIONS, scope, ...Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true])) } as PermissionMap & { scope: TeamScope };
  }
  const table = context.supabase.from("member_permissions" as never);
  const { data, error } = await table.select("*").eq("team_id", teamId).eq("user_id", context.userId).maybeSingle();
  if (error) throw new Error("Не удалось загрузить права сотрудника: " + error.message);
  const row = (data ?? {}) as Record<string, boolean | undefined>;
  const map = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, row[PERMISSION_COLUMNS[key]] === true])) as PermissionMap;
  return { ...map, scope };
}

export async function requirePermission(context: ServerContext, teamId: string, permission: Permission) {
  const permissions = await memberPermissions(context, teamId);
  if (!permissions.scope) throw new Error("Нет доступа к команде");
  if (!permissions[permission]) throw new Error("Недостаточно прав для этого действия");
  return permissions.scope;
}

export async function requireFolderAccess(context: ServerContext, teamId: string, folder: string) {
  const scope = await teamScope(context, teamId);
  if (!scope) throw new Error("Нет доступа к команде");
  const { data: existing, error: folderError } = await context.supabase.from("profile_folders")
    .select("id").eq("team_id", teamId).eq("name", folder).maybeSingle();
  if (folderError) throw new Error("Не удалось проверить папку: " + folderError.message);
  if (!existing) throw new Error("Сначала создайте папку в разделе «Папки»");
  if (scope !== "member") return;
  const { data, error } = await context.supabase.from("folder_access").select("folder")
    .eq("team_id", teamId).eq("folder", folder).eq("user_id", context.userId).maybeSingle();
  if (error) throw new Error("Не удалось проверить доступ к папке: " + error.message);
  if (!data) throw new Error("Эта папка вам недоступна");
}

export async function accessibleFolders(context: ServerContext, teamId: string): Promise<string[] | null> {
  const scope = await teamScope(context, teamId);
  if (scope !== "member") return null;
  const { data, error } = await context.supabase.from("folder_access").select("folder")
    .eq("team_id", teamId).eq("user_id", context.userId);
  if (error) throw new Error("Не удалось загрузить доступные папки: " + error.message);
  return [...new Set((data ?? []).map((row) => row.folder as string))];
}

export async function requireTeamManager(context: ServerContext, teamId: string) {
  const scope = await teamScope(context, teamId);
  if (scope !== "owner" && scope !== "manager") throw new Error("Недостаточно прав: нужен уровень администратора");
  return scope;
}
export async function requireTeamAccess(context: ServerContext, teamId: string) {
  const { data, error } = await context.supabase.from("teams").select("id").eq("id", teamId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Нет доступа к команде");
}
export async function requireProfile(context: ServerContext, profileId: string, access: boolean | "owner" = false) {
  const { data, error } = await context.supabase.from("browser_profiles").select("id, team_id").eq("id", profileId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Нет доступа к профилю");
  if (access === "owner") await requireTeamOwner(context, data.team_id);
  else if (access) await requireTeamManager(context, data.team_id);
  return data;
}
export async function requireTeamProxy(context: ServerContext, teamId: string, proxyId: string | null | undefined) {
  if (!proxyId) return;
  const { data, error } = await context.supabase.from("proxies").select("id").eq("id", proxyId).eq("team_id", teamId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Прокси недоступен или принадлежит другой команде");
}
export async function writeAudit(context: ServerContext, teamId: string, action: string, targetId: string, targetType = "profile", meta?: Json) {
  const { error } = await context.supabase.from("audit_log").insert({ team_id: teamId, user_id: context.userId, action, target_type: targetType, target_id: targetId, ...(meta === undefined ? {} : { meta }) });
  if (error) throw new Error(error.message);
}
