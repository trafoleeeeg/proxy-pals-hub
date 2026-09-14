import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Fingerprint } from "./fingerprint";

/**
 * Функции для десктоп-клиента: выдача данных запуска, блокировка профиля,
 * сохранение cookies. Пароли и cookies расшифровываются только здесь,
 * после проверки доступа.
 */

const LOCK_MINUTES = 5;

export const launchProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string; device?: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: profile, error } = await supabase
      .from("browser_profiles")
      .select("id, team_id, name, fingerprint, cookies_enc, proxy_id")
      .eq("id", data.profileId)
      .single();
    if (error || !profile) throw new Error("Нет доступа к этому профилю");

    const now = Date.now();
    const { data: lock } = await supabase
      .from("profile_locks")
      .select("user_id, expires_at")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (lock && lock.user_id !== userId && new Date(lock.expires_at).getTime() > now) {
      throw new Error("Профиль уже открыт другим участником команды");
    }

    const expiresAt = new Date(now + LOCK_MINUTES * 60_000).toISOString();
    await supabase.from("profile_locks").upsert(
      {
        profile_id: profile.id,
        user_id: userId,
        device_label: data.device ?? null,
        heartbeat_at: new Date().toISOString(),
        expires_at: expiresAt,
      },
      { onConflict: "profile_id" },
    );

    let proxy: {
      protocol: string;
      host: string;
      port: number;
      username: string | null;
      password: string;
    } | null = null;

    if (profile.proxy_id) {
      const { data: p } = await supabase
        .from("proxies")
        .select("protocol, host, port, username, password_enc")
        .eq("id", profile.proxy_id)
        .maybeSingle();
      if (p) {
        const { decryptSecret } = await import("./crypto.server");
        proxy = {
          protocol: p.protocol,
          host: p.host,
          port: p.port,
          username: p.username,
          password: decryptSecret(p.password_enc),
        };
      }
    }

    const { decryptSecret } = await import("./crypto.server");
    const cookies = profile.cookies_enc ? decryptSecret(profile.cookies_enc) : "[]";

    await supabase.from("audit_log").insert({
      team_id: profile.team_id,
      user_id: userId,
      action: "profile.launched",
      target_type: "profile",
      target_id: profile.id,
      meta: { device: data.device ?? null },
    });

    return {
      profileId: profile.id,
      name: profile.name,
      fingerprint: profile.fingerprint as unknown as Fingerprint,
      proxy,
      cookies,
      lockExpiresAt: expiresAt,
    };
  });

export const heartbeatProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string }) => d)
  .handler(async ({ data, context }) => {
    const expiresAt = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
    await context.supabase
      .from("profile_locks")
      .update({ heartbeat_at: new Date().toISOString(), expires_at: expiresAt })
      .eq("profile_id", data.profileId)
      .eq("user_id", context.userId);
    return { expiresAt };
  });

export const closeProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string; cookies?: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (typeof data.cookies === "string") {
      const { encryptSecret } = await import("./crypto.server");
      await supabase
        .from("browser_profiles")
        .update({ cookies_enc: encryptSecret(data.cookies) })
        .eq("id", data.profileId);
    }
    await supabase
      .from("profile_locks")
      .delete()
      .eq("profile_id", data.profileId)
      .eq("user_id", userId);
    return { ok: true };
  });

/** Принудительно снять блокировку — только владелец команды. */
export const forceUnlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("profile_locks")
      .delete()
      .eq("profile_id", data.profileId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
