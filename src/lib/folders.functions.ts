import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createFolderSchema, folderAccessSchema, folderIdSchema, renameFolderSchema, teamSchema, transferSchema } from "./server-validation";
import { accessibleFolders, callServerRpc, memberPermissions, requirePermission, requireTeamManager, writeAudit } from "./server-db";

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
    await requirePermission(context, data.teamId, "profile.edit");
    const moved = await callServerRpc(context.supabase, "transfer_profiles", {
      _team_id: data.teamId,
      _profile_ids: data.profileIds,
      _folder: data.folder,
      _user_id: null,
    });
    return { moved };
  });

export const DEFAULT_FOLDER = "Основная";
export type FolderRow = { id: string; name: string; isDefault: boolean; virtual: boolean };

export const listFolders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(teamSchema)
  .handler(async ({ data, context }): Promise<FolderRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("profile_folders")
      .select("id, name, is_default")
      .eq("team_id", data.teamId)
      .order("is_default", { ascending: false })
      .order("name");
    if (error) throw new Error("Не удалось загрузить папки");
    // Сотрудник видит только те папки, которые ему открыл владелец.
    const rights = await memberPermissions(context, data.teamId);
    const allowed = rights["folder.manage"] ? null : await accessibleFolders(context, data.teamId);
    const list: FolderRow[] = (rows ?? [])
      .filter((row) => allowed === null || allowed.includes(row.name))
      .map((row) => ({ id: row.id, name: row.name, isDefault: row.is_default, virtual: false }));
    // Папки, заданные прямо в профилях, тоже показываем — иначе их не видно в меню.
    const { data: used } = await context.supabase
      .from("browser_profiles").select("folder").eq("team_id", data.teamId);
    const known = new Set(list.map((row) => row.name));
    for (const row of used ?? []) {
      const name = (row.folder ?? "").trim();
      if (!name || known.has(name)) continue;
      if (allowed !== null && !allowed.includes(name)) continue;
      known.add(name);
      list.push({ id: `virtual:${name}`, name, isDefault: false, virtual: true });
    }
    return list.sort((a, b) =>
      a.isDefault === b.isDefault ? a.name.localeCompare(b.name, "ru") : a.isDefault ? -1 : 1);
  });


export const createFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(createFolderSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "folder.manage");
    const { data: row, error } = await context.supabase
      .from("profile_folders")
      .insert({ team_id: data.teamId, name: data.name, created_by: context.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.code === "23505" ? "Папка с таким названием уже есть" : "Не удалось создать папку");
    await writeAudit(context, data.teamId, "folder.created", row.id, "folder");
    return { id: row.id };
  });

export const renameFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(renameFolderSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "folder.manage");
    await callServerRpc(context.supabase, "rename_team_folder", {
      _team_id: data.teamId, _folder_id: data.id, _name: data.name,
    });
    return { ok: true };
  });

export const deleteFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(folderIdSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "folder.manage");
    await callServerRpc(context.supabase, "delete_team_folder", {
      _team_id: data.teamId, _folder_id: data.id,
    });
    return { ok: true };
  });
