import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Fingerprint } from "./fingerprint";
import type { Json } from "@/integrations/supabase/types";

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
  lock: { userId: string; email: string; expiresAt: string } | null;
};

export const listProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("browser_profiles")
      .select("id, name, folder, tags, notes, proxy_id, fingerprint, created_at, updated_at")
      .eq("team_id", data.teamId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const ids = (rows ?? []).map((r) => r.id);
    const { data: locks } = ids.length
      ? await context.supabase
          .from("profile_locks")
          .select("profile_id, user_id, expires_at")
          .in("profile_id", ids)
      : { data: [] };

    const now = Date.now();
    const lockMap = new Map(
      (locks ?? [])
        .filter((l) => new Date(l.expires_at).getTime() > now)
        .map((l) => [l.profile_id, l]),
    );

    return (rows ?? []).map((r) => ({
      ...r,
      fingerprint: (r.fingerprint ?? {}) as Fingerprint,
      lock: lockMap.get(r.id)
        ? {
            userId: lockMap.get(r.id)!.user_id,
            expiresAt: lockMap.get(r.id)!.expires_at,
          }
        : null,
    }));
  });

export const saveProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      teamId: string;
      name: string;
      folder: string;
      tags: string[];
      notes: string;
      proxyId: string | null;
      fingerprint: Fingerprint;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const payload = {
      team_id: data.teamId,
      name: data.name.trim() || "Без названия",
      folder: data.folder.trim(),
      tags: data.tags,
      notes: data.notes,
      proxy_id: data.proxyId,
      fingerprint: data.fingerprint as unknown as Json,
      created_by: context.userId,
    };

    if (data.id) {
      const { error } = await context.supabase
        .from("browser_profiles")
        .update(payload)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      await context.supabase.from("audit_log").insert({
        team_id: data.teamId,
        user_id: context.userId,
        action: "profile.updated",
        target_type: "profile",
        target_id: data.id,
        meta: { name: payload.name },
      });
      return { id: data.id };
    }

    const { data: row, error } = await context.supabase
      .from("browser_profiles")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_log").insert({
      team_id: data.teamId,
      user_id: context.userId,
      action: "profile.created",
      target_type: "profile",
      target_id: row.id,
      meta: { name: payload.name },
    });
    return { id: row.id };
  });

export const bulkCreateProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      teamId: string;
      prefix: string;
      count: number;
      folder: string;
      fingerprints: Fingerprint[];
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const rows = data.fingerprints.slice(0, 200).map((fp, i) => ({
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
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("browser_profiles").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const cloneProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: src, error } = await context.supabase
      .from("browser_profiles")
      .select("team_id, name, folder, tags, notes, proxy_id, fingerprint")
      .eq("id", data.id)
      .single();
    if (error || !src) throw new Error("Профиль не найден");
    const { data: row, error: insErr } = await context.supabase
      .from("browser_profiles")
      .insert({ ...src, name: `${src.name} (копия)`, created_by: context.userId })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    return { id: row.id };
  });
