import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  DESKTOP_PROXY_CHECK_REQUIRED, normalizeProxyCheck, parseProxyImport,
  validateProxyFields, validateProxyInput, validateProxyProtocol,
  validateProxyTarget, validateProxyTeam, validateRotationUrl,
} from "./proxy-input";
import type { ProxyCheckResult, ProxyInput, ProxyProtocol, ProxyRotationStatus } from "./proxy-input";
import { rotationExpired, rotationOutcome } from "./proxy-rotation";

export type { ProxyInput } from "./proxy-input";
type Context = { supabase: SupabaseClient<Database>; userId: string };
type Target = { id: string; teamId: string };

export type ProxyListRow = {
  id: string;
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  country: string | null;
  city: string | null;
  last_checked_at: string | null;
  last_check_ok: boolean | null;
  last_check_ip: string | null;
  last_check_latency_ms: number | null;
  last_check_error: string | null;
  hasPassword: boolean;
  rotationUrlConfigured: boolean;
  rotationStatus: ProxyRotationStatus;
  rotationPreviousIp: string | null;
  rotationNewIp: string | null;
  rotationChangedAt: string | null;
  rotationRequestedAt: string | null;
  rotationLastError: string | null;
};

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
    const db = context.supabase as any;
    const { data: rows, error } = await db.from("proxies")
      .select("id, label, protocol, host, port, username, country, city, last_checked_at, last_check_ok, last_check_ip, last_check_latency_ms, last_check_error, password_enc, rotation_url_enc, rotation_status, rotation_previous_ip, rotation_new_ip, rotation_changed_at, rotation_requested_at, rotation_last_error")
      .eq("team_id", data.teamId).order("created_at", { ascending: false });
    if (error) throw new Error("Не удалось загрузить прокси");
    const rawRows = (rows ?? []) as unknown as Array<Record<string, unknown>>;
    return rawRows.map((row) => ({
      id: String(row["id"]), label: String(row["label"] ?? ""), protocol: row["protocol"] as ProxyProtocol,
      host: String(row["host"]), port: Number(row["port"]), username: (row["username"] as string | null) ?? null,
      country: (row["country"] as string | null) ?? null, city: (row["city"] as string | null) ?? null,
      last_checked_at: (row["last_checked_at"] as string | null) ?? null,
      last_check_ok: (row["last_check_ok"] as boolean | null) ?? null,
      last_check_ip: (row["last_check_ip"] as string | null) ?? null,
      last_check_latency_ms: (row["last_check_latency_ms"] as number | null) ?? null,
      // Older records may contain raw transport errors with proxy credentials.
      last_check_error: row["last_check_error"] ? "Прокси не прошёл проверку подключения" : null,
      hasPassword: Boolean(row["password_enc"]),
      rotationUrlConfigured: Boolean(row["rotation_url_enc"]),
      rotationStatus: row["rotation_status"] === "changing" && rotationExpired(row["rotation_requested_at"] as string | null)
        ? "error" : (row["rotation_status"] as ProxyRotationStatus | null) ?? "not_configured",
      rotationPreviousIp: (row["rotation_previous_ip"] as string | null) ?? null,
      rotationNewIp: (row["rotation_new_ip"] as string | null) ?? null,
      rotationChangedAt: (row["rotation_changed_at"] as string | null) ?? null,
      rotationRequestedAt: (row["rotation_requested_at"] as string | null) ?? null,
      rotationLastError: row["rotation_last_error"] ? "Не удалось подтвердить смену IP" : null,
    })) satisfies ProxyListRow[];
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
    const payload: Record<string, unknown> = {
      label: data.label, protocol: data.protocol, host: data.host, port: data.port,
      username: data.username || null, country: data.country || null,
      ...(data.passwordAction === "replace" ? { password_enc: encryptSecret(data.password!) } : {}),
      ...(data.passwordAction === "clear" ? { password_enc: null } : {}),
    };
    if (data.rotationAction === "replace") {
      payload["rotation_url_enc"] = encryptSecret(data.rotationUrl!);
      payload["rotation_status"] = "ready";
      payload["rotation_last_error"] = null;
    }
    if (data.rotationAction === "clear") {
      payload["rotation_url_enc"] = null;
      payload["rotation_status"] = "not_configured";
      payload["rotation_previous_ip"] = null;
      payload["rotation_new_ip"] = null;
      payload["rotation_changed_at"] = null;
      payload["rotation_requested_at"] = null;
      payload["rotation_last_error"] = null;
    }
    if (data.id) {
      const { data: row, error } = await context.supabase.from("proxies").update({
        ...payload, last_checked_at: null, last_check_ok: null, last_check_ip: null,
        last_check_latency_ms: null, last_check_error: null, city: null,
      } as never).eq("id", data.id).eq("team_id", data.teamId).select("id").maybeSingle();
      if (error?.code === "55P03") throw new Error("Закройте профили, использующие этот прокси, перед изменением подключения");
      if (error || !row) throw new Error("Не удалось обновить прокси: проверьте доступ и повторите попытку");
      return { id: row.id };
    }
    const { data: row, error } = await context.supabase.from("proxies")
      .insert({ ...payload, team_id: data.teamId, created_by: context.userId } as never)
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
  .inputValidator((data: Target & ProxyCheckResult & { rotationRequestedAt?: string; rotationFinal?: boolean }) => {
    if (data.rotationRequestedAt !== undefined && (typeof data.rotationRequestedAt !== "string" || !Number.isFinite(Date.parse(data.rotationRequestedAt)))) throw new Error("Некорректная проверка смены IP");
    return { ...validateProxyTarget(data), ...normalizeProxyCheck(data), rotationRequestedAt: data.rotationRequestedAt, rotationFinal: data.rotationFinal === true };
  })
  .handler(async ({ data, context }) => {
    await requireProxy(context, data);
    const db = context.supabase as any;
    const { data: current, error: currentError } = await db.from("proxies")
      .select("last_check_ip, rotation_status, rotation_changed_at, rotation_previous_ip, rotation_requested_at")
      .eq("id", data.id).eq("team_id", data.teamId).maybeSingle();
    if (currentError || !current) throw new Error("Не удалось прочитать состояние прокси");
    const now = new Date().toISOString();
    const confirmsRotation = !!data.rotationRequestedAt && data.rotationRequestedAt === current["rotation_requested_at"] && current["rotation_status"] === "changing";
    if (data.rotationRequestedAt && !confirmsRotation) throw new Error("Эта проверка относится к предыдущей смене IP");
    const outcome = confirmsRotation ? rotationOutcome(current["rotation_previous_ip"], data, data.rotationFinal || rotationExpired(current["rotation_requested_at"])) : null;
    const rotation = outcome ? {
      rotation_status: outcome,
      rotation_last_error: outcome === "error" ? "not_confirmed" : null,
      ...(outcome === "success" ? { rotation_new_ip: data.ip, rotation_changed_at: now } : {}),
    } : {};
    let update = db.from("proxies").update({
      last_checked_at: now, last_check_ok: data.ok,
      last_check_ip: data.ip ?? null, last_check_latency_ms: data.latency ?? null,
      last_check_error: data.ok ? null : data.error ?? null,
      ...(data.ok && data.country ? { country: data.country } : {}),
      ...(data.ok && data.city ? { city: data.city } : {}),
      ...rotation,
    } as never).eq("id", data.id).eq("team_id", data.teamId);
    if (confirmsRotation) update = update.eq("rotation_requested_at", data.rotationRequestedAt).eq("rotation_status", "changing");
    const { data: row, error } = await update.select("id").maybeSingle();
    if (error || !row) throw new Error("Проверка завершена, но результат не сохранён. Проверьте доступ и повторите попытку");
    return { ok: true };
  });

/** Requests the provider's mobile IP rotation endpoint. The follow-up desktop
 * check records whether the exit IP actually changed. */
export const rotateProxyIp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Target) => validateProxyTarget(data))
  .handler(async ({ data, context }) => {
    await requireProxy(context, data);
    const db = context.supabase as any;
    const { data: proxy, error: readError } = await db.from("proxies")
      .select("rotation_url_enc, last_check_ip, last_check_ok, last_checked_at, rotation_status, rotation_requested_at")
      .eq("id", data.id).eq("team_id", data.teamId).maybeSingle();
    if (readError) throw new Error("Не удалось прочитать настройки смены IP");
    if (!proxy?.rotation_url_enc) throw new Error("Для этого прокси не настроена ссылка смены IP");
    if (proxy.rotation_status === "changing" && !rotationExpired(proxy.rotation_requested_at)) throw new Error("Смена IP уже выполняется");
    const lastCheck = Date.parse(proxy.last_checked_at ?? "");
    if (!proxy.last_check_ok || !proxy.last_check_ip || !Number.isFinite(lastCheck) || Date.now() - lastCheck > 60_000) throw new Error("Сначала проверьте текущий IP прокси");
    const { decryptSecret } = await import("./crypto.server");
    let url: string;
    try { url = validateRotationUrl(decryptSecret(proxy.rotation_url_enc), false); }
    catch { throw new Error("Ссылка смены IP повреждена. Сохраните её заново"); }
    const requestedAt = new Date().toISOString();
    let claim = db.from("proxies").update({
      rotation_status: "changing", rotation_requested_at: requestedAt, rotation_last_error: null,
      rotation_previous_ip: proxy.last_check_ip, rotation_new_ip: null,
    }).eq("id", data.id).eq("team_id", data.teamId).eq("rotation_status", proxy.rotation_status).eq("rotation_url_enc", proxy.rotation_url_enc);
    if (proxy.rotation_requested_at) claim = claim.eq("rotation_requested_at", proxy.rotation_requested_at);
    else claim = claim.is("rotation_requested_at", null);
    const { data: claimed, error: markChangingError } = await claim.select("id").maybeSingle();
    if (markChangingError || !claimed) throw new Error("Состояние прокси изменилось. Обновите список и повторите");
    try {
      const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error("provider response");
    } catch {
      const { error: markFailureError } = await db.from("proxies").update({ rotation_status: "error", rotation_last_error: "provider" })
        .eq("id", data.id).eq("team_id", data.teamId).eq("rotation_requested_at", requestedAt);
      if (markFailureError) throw new Error("Не удалось сохранить состояние смены IP");
      throw new Error("Ссылка смены IP недоступна. Проверьте адрес провайдера");
    }
    return { ok: true, previousIp: proxy.last_check_ip ?? null, requestedAt };
  });

/** Cloudflare fetch cannot implement an arbitrary HTTP CONNECT / SOCKS tunnel. */
export const checkProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Target) => validateProxyTarget(data))
  .handler(async ({ data, context }) => {
    await requireProxy(context, data);
    return DESKTOP_PROXY_CHECK_REQUIRED;
  });
