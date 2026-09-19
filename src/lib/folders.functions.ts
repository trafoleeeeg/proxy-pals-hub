import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createFolderSchema, folderAccessSchema, folderIdSchema, renameFolderSchema, teamSchema, transferSchema } from "./server-validation";
import { accessibleFolders, callServerRpc, requirePermission, requireTeamManager, writeAudit } from "./server-db";

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
export type FolderRow = { id: string; name: string; isDefault: boolean };

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
    const allowed = await accessibleFolders(context, data.teamId);
    return (rows ?? [])
      .filter((row) => allowed === null || allowed.includes(row.name))
      .map((row) => ({ id: row.id, name: row.name, isDefault: row.is_default }));
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
    const { data: current, error: readError } = await context.supabase
      .from("profile_folders").select("name").eq("id", data.id).eq("team_id", data.teamId).maybeSingle();
    if (readError || !current) throw new Error("Папка не найдена");
    const { error } = await context.supabase
      .from("profile_folders").update({ name: data.name }).eq("id", data.id).eq("team_id", data.teamId);
    if (error) throw new Error(error.code === "23505" ? "Папка с таким названием уже есть" : "Не удалось переименовать папку");
    await context.supabase.from("browser_profiles").update({ folder: data.name })
      .eq("team_id", data.teamId).eq("folder", current.name);
    await context.supabase.from("folder_access").update({ folder: data.name })
      .eq("team_id", data.teamId).eq("folder", current.name);
    await writeAudit(context, data.teamId, "folder.renamed", data.id, "folder");
    return { ok: true };
  });

export const deleteFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(folderIdSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "folder.manage");
    const { data: current, error: readError } = await context.supabase
      .from("profile_folders").select("name, is_default").eq("id", data.id).eq("team_id", data.teamId).maybeSingle();
    if (readError || !current) throw new Error("Папка не найдена");
    if (current.is_default) throw new Error("Основную папку удалить нельзя");
    const { data: locked } = await context.supabase
      .from("browser_profiles").select("id, profile_locks(expires_at)")
      .eq("team_id", data.teamId).eq("folder", current.name);
    const now = Date.now();
    const busy = (locked ?? []).some((row) => {
      const lock = (row as { profile_locks?: { expires_at: string }[] | { expires_at: string } | null }).profile_locks;
      const list = Array.isArray(lock) ? lock : lock ? [lock] : [];
      return list.some((item) => new Date(item.expires_at).getTime() > now);
    });
    if (busy) throw new Error("Сначала закройте открытые профили этой папки");
    await context.supabase.from("browser_profiles").update({ folder: DEFAULT_FOLDER })
      .eq("team_id", data.teamId).eq("folder", current.name);
    await context.supabase.from("folder_access").delete().eq("team_id", data.teamId).eq("folder", current.name);
    const { error } = await context.supabase.from("profile_folders").delete().eq("id", data.id).eq("team_id", data.teamId);
    if (error) throw new Error("Не удалось удалить папку");
    await writeAudit(context, data.teamId, "folder.deleted", data.id, "folder");
    return { ok: true };
  });
