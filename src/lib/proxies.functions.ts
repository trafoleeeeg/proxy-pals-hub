import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  DESKTOP_PROXY_CHECK_REQUIRED, normalizeProxyCheck, parseProxyImport,
  validateProxyFields, validateProxyInput, validateProxyProtocol,
  validateProxyTarget, validateProxyTeam,
} from "./proxy-input";
import type { ProxyCheckResult, ProxyInput, ProxyProtocol } from "./proxy-input";

export type { ProxyInput } from "./proxy-input";
type Context = { supabase: SupabaseClient<Database>; userId: string };
type Target = { id: string; teamId: string };

async function requireTeam(context: Context, teamId: string, owner = true) {
  const denied = owner ? "Доступ только для владельца команды" : "Нет доступа к команде";
  const { data: team, error: teamError } = await context.supabase.from("teams").select("owner_id")
    .eq("id", teamId).maybeSingle();
  if (teamError || !team) throw new Error(denied);
  if (team.owner_id === context.userId) return;
  if (owner) throw new Error(denied);
  const { data, error } = await context.supabase.from("team_members").select("role")
    .eq("team_id", teamId).eq("user_id", context.userId).maybeSingle();
  if (error || !data) throw new Error(denied);
}

async function requireProxy(context: Context, target: Target) {
  await requireTeam(context, target.teamId);
  const { data, error } = await context.supabase.from("proxies").select("id")
    .eq("id", target.id).eq("team_id", target.teamId).maybeSingle();
  if (error || !data) throw new Error("Прокси не найден в выбранной команде");
}

export const listProxies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { teamId: string }) => validateProxyTeam(data))
  .handler(async ({ data, context }) => {
    await requireTeam(context, data.teamId, false);
    const { data: rows, error } = await context.supabase.from("proxies")
      .select("id, label, protocol, host, port, username, country, city, last_checked_at, last_check_ok, last_check_ip, last_check_latency_ms, last_check_error, password_enc")
      .eq("team_id", data.teamId).order("created_at", { ascending: false });
    if (error) throw new Error("Не удалось загрузить прокси");
    return (rows ?? []).map(({ password_enc, last_check_error, ...rest }) => ({
      ...rest,
      // Older records may contain raw transport errors with proxy credentials.
      last_check_error: last_check_error ? "Прокси не прошёл проверку подключения" : null,
      hasPassword: Boolean(password_enc),
    }));
  });

export const saveProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: ProxyInput) => validateProxyInput(data))
  .handler(async ({ data, context }) => {
    if (data.id) await requireProxy(context, { id: data.id, teamId: data.teamId });
    else await requireTeam(context, data.teamId);
    if (data.id && data.passwordAction === "preserve" && !data.username) {
      const { data: existing, error } = await context.supabase.from("proxies").select("password_enc")
        .eq("id", data.id).eq("team_id", data.teamId).maybeSingle();
      if (error || !existing) throw new Error("Не удалось прочитать настройки прокси");
      if (existing.password_enc) throw new Error("Чтобы удалить логин, удалите также пароль прокси");
    }
    const { encryptSecret } = await import("./crypto.server");
    const payload = {
      label: data.label, protocol: data.protocol, host: data.host, port: data.port,
      username: data.username || null, country: data.country || null,
      ...(data.passwordAction === "replace" ? { password_enc: encryptSecret(data.password!) } : {}),
      ...(data.passwordAction === "clear" ? { password_enc: null } : {}),
    };
    if (data.id) {
      const { data: row, error } = await context.supabase.from("proxies").update({
        ...payload, last_checked_at: null, last_check_ok: null, last_check_ip: null,
        last_check_latency_ms: null, last_check_error: null, city: null,
      }).eq("id", data.id).eq("team_id", data.teamId).select("id").maybeSingle();
      if (error?.code === "55P03") throw new Error("Закройте профили, использующие этот прокси, перед изменением подключения");
      if (error || !row) throw new Error("Не удалось обновить прокси: проверьте доступ и повторите попытку");
      return { id: row.id };
    }
    const { data: row, error } = await context.supabase.from("proxies")
      .insert({ ...payload, team_id: data.teamId, created_by: context.userId })
      .select("id").single();
    if (error || !row) throw new Error("Не удалось сохранить прокси");
    const { error: auditError } = await context.supabase.from("audit_log").insert({
      team_id: data.teamId, user_id: context.userId, action: "proxy.created",
      target_type: "proxy", target_id: row.id,
    });
    if (auditError) throw new Error("Прокси сохранён, но запись в журнале действий не создана. Обновите список прокси");
    return { id: row.id };
  });

export const deleteProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Target) => validateProxyTarget(data))
  .handler(async ({ data, context }) => {
    await requireProxy(context, data);
    const inUse = "Прокси используется профилями. Сначала назначьте им другой прокси";
    const { data: profiles, error: profilesError } = await context.supabase.from("browser_profiles")
      .select("id").eq("proxy_id", data.id).limit(1);
    if (profilesError) throw new Error("Не удалось проверить использование прокси");
    if (profiles?.length) throw new Error(inUse);
    // The FK's ON DELETE RESTRICT also protects concurrent profile assignments.
    const { data: row, error } = await context.supabase.from("proxies").delete()
      .eq("id", data.id).eq("team_id", data.teamId).select("id").maybeSingle();
    if (error?.code === "23503") throw new Error(inUse);
    if (error || !row) throw new Error("Не удалось удалить прокси: проверьте доступ и повторите попытку");
    return { ok: true };
  });

export const importProxies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { teamId: string; text: string; protocol?: ProxyProtocol | undefined }) => {
    const team = validateProxyTeam(data);
    return { ...team, ...parseProxyImport(data.text, validateProxyProtocol(data.protocol ?? "http")) };
  })
  .handler(async ({ data, context }) => {
    await requireTeam(context, data.teamId);
    if (data.issues.length) return { added: 0, issues: data.issues };
    const { encryptSecret } = await import("./crypto.server");
    const rows = data.rows.map(({ password, username, country, ...proxy }) => ({
      ...proxy, username: username || null, country: country || null,
      team_id: data.teamId, created_by: context.userId,
      password_enc: password ? encryptSecret(password) : null,
    }));
    const { data: inserted, error } = await context.supabase.from("proxies").insert(rows).select("id");
    if (error || inserted?.length !== rows.length) throw new Error("Не удалось импортировать прокси");
    return { added: inserted.length, issues: [] };
  });

/** This endpoint is consumed only by the desktop check flow, never cached in queries. */
export const proxyForCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Target) => validateProxyTarget(data))
  .handler(async ({ data, context }) => {
    await requireTeam(context, data.teamId);
    const { data: proxy, error } = await context.supabase.from("proxies")
      .select("id, protocol, host, port, username, password_enc")
      .eq("id", data.id).eq("team_id", data.teamId).maybeSingle();
    if (error || !proxy) throw new Error("Прокси не найден в выбранной команде");
    const { decryptSecret } = await import("./crypto.server");
    let password = "";
    try { password = proxy.password_enc ? decryptSecret(proxy.password_enc) : ""; }
    catch { throw new Error("Не удалось прочитать пароль прокси. Сохраните его заново"); }
    if (proxy.password_enc && !password) throw new Error("Не удалось прочитать пароль прокси. Сохраните его заново");
    const fields = validateProxyFields({ ...proxy, username: proxy.username ?? undefined, password });
    return {
      id: proxy.id, protocol: fields.protocol, host: fields.host, port: fields.port,
      username: fields.username || null, password: fields.password,
    };
  });

export const recordProxyCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Target & ProxyCheckResult) => ({ ...validateProxyTarget(data), ...normalizeProxyCheck(data) }))
  .handler(async ({ data, context }) => {
    await requireProxy(context, data);
    const { data: row, error } = await context.supabase.from("proxies").update({
      last_checked_at: new Date().toISOString(), last_check_ok: data.ok,
      last_check_ip: data.ip ?? null, last_check_latency_ms: data.latency ?? null,
      last_check_error: data.ok ? null : data.error ?? null,
      ...(data.ok && data.country ? { country: data.country } : {}),
      ...(data.ok && data.city ? { city: data.city } : {}),
    }).eq("id", data.id).eq("team_id", data.teamId).select("id").maybeSingle();
    if (error || !row) throw new Error("Проверка завершена, но результат не сохранён. Проверьте доступ и повторите попытку");
    return { ok: true };
  });

/** Cloudflare fetch cannot implement an arbitrary HTTP CONNECT / SOCKS tunnel. */
export const checkProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Target) => validateProxyTarget(data))
  .handler(async ({ data, context }) => {
    await requireProxy(context, data);
    return DESKTOP_PROXY_CHECK_REQUIRED;
  });
