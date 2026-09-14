import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ProxyInput = {
  id?: string | undefined;
  teamId: string;
  label: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  country?: string | undefined;
};

export const listProxies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("proxies")
      .select(
        "id, label, protocol, host, port, username, country, city, last_checked_at, last_check_ok, last_check_ip, last_check_latency_ms, last_check_error, password_enc",
      )
      .eq("team_id", data.teamId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (rows ?? []).map(({ password_enc, ...rest }) => ({
      ...rest,
      hasPassword: Boolean(password_enc),
    }));
  });

export const saveProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: ProxyInput) => d)
  .handler(async ({ data, context }) => {
    const { encryptSecret } = await import("./crypto.server");
    const payload = {
      team_id: data.teamId,
      label: data.label,
      protocol: data.protocol,
      host: data.host.trim(),
      port: data.port,
      username: data.username?.trim() || null,
      country: data.country?.toUpperCase() || null,
      created_by: context.userId,
      ...(data.password ? { password_enc: encryptSecret(data.password) } : {}),
    };

    if (data.id) {
      const { error } = await context.supabase.from("proxies").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("proxies")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_log").insert({
      team_id: data.teamId,
      user_id: context.userId,
      action: "proxy.created",
      target_type: "proxy",
      target_id: row.id,
      meta: { host: data.host },
    });
    return { id: row.id };
  });

export const deleteProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("proxies").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Массовый импорт: scheme://user:pass@host:port или host:port:login:pass */
export const importProxies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { teamId: string; text: string; protocol?: "http" | "https" | "socks5" | undefined }) => d,
  )
  .handler(async ({ data, context }) => {
    const { encryptSecret } = await import("./crypto.server");
    const rows: {
      team_id: string;
      label: string;
      protocol: "http" | "https" | "socks5";
      host: string;
      port: number;
      username: string | null;
      password_enc: string | null;
      created_by: string;
    }[] = [];

    for (const line of data.text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;

      const schemeMatch = /^(https?|socks5):\/\//i.exec(t);
      const protocol = (schemeMatch?.[1]?.toLowerCase() ?? data.protocol ?? "http") as
        | "http"
        | "https"
        | "socks5";
      let rest = t.replace(/^\w+:\/\//, "");

      let user: string | undefined;
      let pass: string | undefined;
      let host: string | undefined;
      let portRaw: string | undefined;

      if (rest.includes("@")) {
        const at = rest.lastIndexOf("@");
        const cred = rest.slice(0, at).split(":");
        rest = rest.slice(at + 1);
        user = cred[0];
        pass = cred[1];
        [host, portRaw] = rest.split(":");
      } else {
        const parts = rest.split(":");
        [host, portRaw, user, pass] = parts;
      }

      const port = Number(portRaw);
      if (!host || !Number.isFinite(port) || port <= 0) continue;

      rows.push({
        team_id: data.teamId,
        label: `${host}:${port}`,
        protocol,
        host,
        port,
        username: user || null,
        password_enc: pass ? encryptSecret(pass) : null,
        created_by: context.userId,
      });
    }

    if (!rows.length) return { added: 0 };
    const { error } = await context.supabase.from("proxies").insert(rows);
    if (error) throw new Error(error.message);
    return { added: rows.length };
  });

/** Проверка прокси: реальный IP, страна, задержка. */
export const checkProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { decryptSecret } = await import("./crypto.server");
    const { data: proxy, error } = await context.supabase
      .from("proxies")
      .select("id, team_id, protocol, host, port, username, password_enc")
      .eq("id", data.id)
      .single();
    if (error || !proxy) throw new Error("Прокси не найден");

    const started = Date.now();
    let result: {
      ok: boolean;
      ip?: string | undefined;
      country?: string | undefined;
      city?: string | undefined;
      error?: string | undefined;
      latency?: number | undefined;
    };

    try {
      const password = decryptSecret(proxy.password_enc);
      const auth =
        proxy.username || password
          ? "Basic " + Buffer.from(`${proxy.username ?? ""}:${password}`).toString("base64")
          : undefined;

      // Воркер не умеет туннелировать SOCKS/HTTP-CONNECT напрямую,
      // поэтому используем публичный HTTP-прокси-запрос через сам прокси.
      const target = "http://ip-api.com/json/?fields=status,country,countryCode,city,query";
      const headers: Record<string, string> = { Host: "ip-api.com" };
      if (auth) headers["Proxy-Authorization"] = auth;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(`http://${proxy.host}:${proxy.port}${new URL(target).pathname}${new URL(target).search}`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const json = (await res.json()) as {
        status?: string;
        query?: string;
        countryCode?: string;
        city?: string;
      };
      result = json.status === "success"
        ? {
            ok: true,
            ip: json.query,
            country: json.countryCode,
            city: json.city,
            latency: Date.now() - started,
          }
        : { ok: false, error: "Прокси ответил, но IP определить не удалось" };
    } catch (e) {
      result = {
        ok: false,
        error: e instanceof Error ? e.message : "Прокси не отвечает",
        latency: Date.now() - started,
      };
    }

    await context.supabase
      .from("proxies")
      .update({
        last_checked_at: new Date().toISOString(),
        last_check_ok: result.ok,
        last_check_ip: result.ip ?? null,
        last_check_latency_ms: result.latency ?? null,
        last_check_error: result.error ?? null,
        country: result.country ?? null,
        city: result.city ?? null,
      })
      .eq("id", proxy.id);

    return result;
  });
