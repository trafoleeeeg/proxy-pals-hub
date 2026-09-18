import { z } from "zod";
import { callServerRpc, serverDb, writeAudit, type ServerContext } from "./server-db";
import { fingerprintSchema, launchSchema } from "./server-validation";
import { parseCookieImport } from "./server-cookies";
import { browserSettingsSchema } from "./browser-settings";
import { bookmarkDefaultsSchema, DEFAULT_TEAM_BOOKMARKS } from "./bookmark-defaults";

const proxySchema = z.object({
  protocol: z.enum(["http", "https", "socks5"]),
  host: z.string().min(1).max(253).refine((v) => !/[\s/@?#]/.test(v)),
  port: z.number().int().min(1).max(65535), username: z.string().max(1024).nullable(),
  password_enc: z.string().nullable(),
});

export async function prepareSessionLaunch(context: ServerContext, data: z.infer<typeof launchSchema>, decryptSecret: (value: string | null | undefined) => string) {
  const deviceId = data.deviceId ?? crypto.randomUUID();
  const lease = await callServerRpc(context.supabase, "acquire_profile_lease", {
    _profile_id: data.profileId, _device_id: deviceId, _device_label: data.device ?? null,
  });
  try {
    const { data: profile, error } = await serverDb(context.supabase).from("browser_profiles")
      .select("id, team_id, name, fingerprint, cookies_enc, cookies_updated_at, proxy_id")
      .eq("id", data.profileId).single();
    if (error) throw new Error(error.message);
    const fingerprint = fingerprintSchema.parse(profile.fingerprint);
    let proxy: { protocol: string; host: string; port: number; username: string | null; password: string } | null = null;
    if (profile.proxy_id) {
      const { data: row, error: proxyError } = await context.supabase.from("proxies")
        .select("protocol, host, port, username, password_enc").eq("id", profile.proxy_id).eq("team_id", profile.team_id).maybeSingle();
      if (proxyError || !row) throw new Error("Назначенный прокси недоступен. Запуск отменён");
      const validated = proxySchema.safeParse(row);
      if (!validated.success) throw new Error("Настройки назначенного прокси некорректны");
      proxy = { protocol: row.protocol, host: row.host, port: row.port, username: row.username, password: decryptSecret(row.password_enc) };
    }
    const { data: proxyRows } = await serverDb(context.supabase).from("proxies")
      .select("id, label, protocol, host, port, username, password_enc, country, city")
      .eq("team_id", profile.team_id);
    const proxies = [...(proxyRows || [])].sort((a, b) => String(a.label).localeCompare(String(b.label), "ru")).flatMap((row) => {
      const validated = proxySchema.safeParse(row);
      if (!validated.success) return [];
      return [{ id: row.id, label: row.label, protocol: row.protocol, host: row.host, port: row.port,
        username: row.username, password: decryptSecret(row.password_enc),
        country: row.country ?? null, city: row.city ?? null }];
    });
    const cookies = profile.cookies_enc ? JSON.stringify(parseCookieImport(decryptSecret(profile.cookies_enc))) : "[]";
    await writeAudit(context, profile.team_id, "profile.launched", profile.id);
    const { data: settingsRow } = await serverDb(context.supabase).from("profile_browser_settings").select("*").eq("profile_id", profile.id).maybeSingle();
    const parsedBrowserSettings = settingsRow ? browserSettingsSchema.safeParse({
      profileId: settingsRow.profile_id, bookmarks: settingsRow.bookmarks,
      bookmarkBarVisible: settingsRow.bookmark_bar_visible, zoomLevel: settingsRow.zoom_level,
      extensions: settingsRow.extensions, revision: settingsRow.revision, updatedAt: settingsRow.updated_at,
      activeProxyId: settingsRow.active_proxy_id ?? null, proxyFailover: settingsRow.proxy_failover ?? false,
    }) : null;
    const browserSettings = parsedBrowserSettings?.success ? parsedBrowserSettings.data : null;
    const defaultsRaw = await callServerRpc(context.supabase, "get_team_bookmark_defaults", { _team_id: profile.team_id });
    const parsedDefaults = bookmarkDefaultsSchema.parse(defaultsRaw);
    const bookmarkDefaults = parsedDefaults.revision === 0 && parsedDefaults.bookmarks.length === 0
      ? { teamId: profile.team_id, bookmarks: [...DEFAULT_TEAM_BOOKMARKS], bookmarkBarVisible: true, revision: 0, updatedAt: null }
      : parsedDefaults;
    return { profileId: profile.id, name: profile.name, fingerprint, proxy, proxies, cookies,
      browserSettings,
      bookmarkDefaults,
      lockToken: lease.lockToken, lockExpiresAt: lease.expiresAt, cookiesUpdatedAt: profile.cookies_updated_at, deviceId };
  } catch (error) {
    try {
      await callServerRpc(context.supabase, "mutate_profile_lease", {
        _profile_id: data.profileId, _lock_token: lease.lockToken, _operation: "close", _cookies_enc: null, _device_id: deviceId,
      });
    } catch {
      throw new Error("Запуск отменён; не удалось снять блокировку. Повторите после истечения блокировки или снимите её в панели");
    }
    throw error;
  }
}

export function requireLeaseToken(token: string | undefined): string {
  if (!token) throw new Error("Для этой сессии требуется токен блокировки. Обновите клиент и откройте профиль заново");
  return token;
}

/** A terminal close cannot commit its cookie snapshot; the caller must stop retrying it. */
export function classifyTerminalClose(error: unknown): "access_revoked" | "lease_lost" | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "No profile access") return "access_revoked";
  if (error.message === "Session lease lost; reopen the profile") return "lease_lost";
  return null;
}
