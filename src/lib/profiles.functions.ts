import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Fingerprint } from "./fingerprint";
import type { Json } from "@/integrations/supabase/types";
import { bulkCreateSchema, bulkDeleteSchema, bulkUpdateSchema, idSchema, importCookiesSchema, profileIdSchema, saveProfileSchema, teamSchema } from "./server-validation";
import { accessibleFolders, callServerRpc, requireFolderAccess, requirePermission, requireProfile, requireTeamAccess, requireTeamProxy, writeAudit } from "./server-db";
import { parseCookieImport } from "./server-cookies";

export type ProfileRow = {
  id: string;
  name: string;
  folder: string;
  tags: string[];
  notes: string;
  proxy_id: string | null;
  fingerprint: Fingerprint;
  created_at: string;
  updated_at: string;
  status_id: string | null;
  custom_fields: Record<string, string>;
  lock: { userId: string; expiresAt: string } | null;
};

export const listProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(teamSchema)
  .handler(async ({ data, context }) => {
    await requireTeamAccess(context, data.teamId);
    const { data: rows, error } = await context.supabase
      .from("browser_profiles")
      .select("id, name, folder, tags, notes, proxy_id, fingerprint, created_at, updated_at, status_id, custom_fields")
      .eq("team_id", data.teamId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const ids = (rows ?? []).map((r) => r.id);
    const { data: locks, error: lockError } = ids.length
      ? await context.supabase
          .from("profile_locks")
          .select("profile_id, user_id, expires_at")
          .in("profile_id", ids)
      : { data: [], error: null };
    if (lockError) throw new Error(lockError.message);

    const now = Date.now();
    const lockMap = new Map(
      (locks ?? [])
        .filter((l) => new Date(l.expires_at).getTime() > now)
        .map((l) => [l.profile_id, l]),
    );

    const lockUserIds = [...new Set([...lockMap.values()].map((lock) => lock.user_id))];
    const { data: lockPeople } = lockUserIds.length
      ? await context.supabase.from("profiles").select("id, email, display_name").in("id", lockUserIds)
      : { data: [] };
    const personById = new Map((lockPeople ?? []).map((person) => [person.id, person]));

    return (rows ?? []).map((r) => {
      const lock = lockMap.get(r.id);
      const person = lock ? personById.get(lock.user_id) : undefined;
      return {
        ...r,
        fingerprint: (r.fingerprint ?? {}) as Fingerprint,
        custom_fields: (r.custom_fields ?? {}) as Record<string, string>,
        lock: lock
          ? {
              userId: lock.user_id,
              expiresAt: lock.expires_at,
              email: person?.email ?? "",
              name: person?.display_name ?? "",
            }
          : null,
      };
    });
  });

export const saveProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(saveProfileSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, data.id ? "profile.edit" : "profile.create");
    await requireFolderAccess(context, data.teamId, data.folder.trim());
    if (data.proxyId) await requirePermission(context, data.teamId, "profile.proxy");
    await requireTeamProxy(context, data.teamId, data.proxyId);
    const payload = {
      name: data.name,
      folder: data.folder.trim(),
      tags: data.tags,
      notes: data.notes,
      proxy_id: data.proxyId,
      fingerprint: data.fingerprint as unknown as Json,
      status_id: data.statusId ?? null,
      custom_fields: data.customFields ?? {},
    };

    if (data.id) {
      const { data: updated, error } = await context.supabase
        .from("browser_profiles")
        .update(payload)
        .eq("id", data.id).eq("team_id", data.teamId).select("id").single();
      if (error) throw new Error(error.message);
      await writeAudit(context, data.teamId, "profile.updated", updated.id);
      return { id: updated.id };
    }

    const { data: row, error } = await context.supabase
      .from("browser_profiles")
      .insert({ ...payload, team_id: data.teamId, created_by: context.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await writeAudit(context, data.teamId, "profile.created", row.id);
    return { id: row.id };
  });

export const bulkCreateProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(bulkCreateSchema)
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
    const rows = data.fingerprints.map((fp, i) => ({
      team_id: data.teamId,
      name: `${data.prefix} ${i + 1}`,
      folder: data.folder,
      tags: [] as string[],
      notes: "",
      fingerprint: fp as unknown as Json,
      created_by: context.userId,
    }));
    if (!rows.length) return { added: 0 };
    const { error } = await context.supabase.from("browser_profiles").insert(rows);
    if (error) throw new Error(error.message);
    return { added: rows.length };
  });

export const deleteProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idSchema)
  .handler(async ({ data, context }) => {
    const profile = await requireProfile(context, data.id, true);
    await callServerRpc(context.supabase, "bulk_mutate_profiles", {
      _team_id: profile.team_id, _profile_ids: [data.id], _operation: "delete", _changes: {},
    });
    return { ok: true };
  });

export const cloneProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(idSchema)
  .handler(async ({ data, context }) => {
    await requireProfile(context, data.id, true);
    const { data: src, error } = await context.supabase
      .from("browser_profiles")
      .select("team_id, name, folder, tags, notes, proxy_id, fingerprint, status_id, custom_fields")
      .eq("id", data.id)
      .single();
    if (error || !src) throw new Error("Профиль не найден");
    const { data: row, error: insErr } = await context.supabase
      .from("browser_profiles")
      .insert({ ...src, name: `${src.name.slice(0, 190)} (копия)`, created_by: context.userId })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    return { id: row.id };
  });

export const bulkUpdateProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(bulkUpdateSchema)
  .handler(async ({ data, context }) => {
    await requireTeamManager(context, data.teamId);
    await requireTeamProxy(context, data.teamId, data.changes.proxyId);
    const updated = await callServerRpc(context.supabase, "bulk_mutate_profiles", {
      _team_id: data.teamId, _profile_ids: data.ids, _operation: "update", _changes: data.changes as Json,
    });
    return { updated };
  });

export const bulkDeleteProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(bulkDeleteSchema)
  .handler(async ({ data, context }) => ({ deleted: await callServerRpc(context.supabase, "bulk_mutate_profiles", {
    _team_id: data.teamId, _profile_ids: data.ids, _operation: "delete", _changes: {},
  }) }));

export const importProfileCookies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(importCookiesSchema)
  .handler(async ({ data, context }) => {
    // Cookies остаются секретом владельца: администратор их не выгружает и не подменяет.
    await requireProfile(context, data.profileId, "owner");
    const cookies = parseCookieImport(data.text);
    const { encryptSecret } = await import("./crypto.server");
    await callServerRpc(context.supabase, "import_profile_cookies", {
      _profile_id: data.profileId, _cookies_enc: encryptSecret(JSON.stringify(cookies)),
    });
    return { imported: cookies.length };
  });

export const exportProfileCookies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(profileIdSchema)
  .handler(async ({ data, context }) => {
    const profile = await requireProfile(context, data.profileId, "owner");
    const { data: row, error } = await context.supabase.from("browser_profiles").select("cookies_enc").eq("id", data.profileId).single();
    if (error) throw new Error(error.message);
    const { decryptSecret } = await import("./crypto.server");
    const cookies = row.cookies_enc ? parseCookieImport(decryptSecret(row.cookies_enc)) : [];
    await writeAudit(context, profile.team_id, "profile.cookies_exported", profile.id);
    return { cookies: JSON.stringify(cookies) };
  });
