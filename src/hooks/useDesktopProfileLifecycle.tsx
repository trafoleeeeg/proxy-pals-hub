import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { launchProfile, closeProfile, heartbeatProfile, saveProfileSession } from "@/lib/session.functions";
import { desktop, DesktopProfileLifecycle, type LifecycleSnapshot, type UpdateStatus } from "@/lib/desktop";
import { saveBrowserSettings, fetchBrowserSettings } from "@/lib/bookmarks-sync.functions";
import { browserSettingsSchema, type BrowserSettings } from "@/lib/browser-settings";
import { supabase } from "@/integrations/supabase/client";
import { bookmarkDefaultsSchema } from "@/lib/bookmark-defaults";

const EMPTY: LifecycleSnapshot = { running: [], busy: [], pending: [], errors: {}, notices: {}, restoring: false };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
type UpdateAction = "check" | "download" | "install";
type Runtime = LifecycleSnapshot & {
  available: boolean;
  ready: boolean;
  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  retry: () => Promise<void>;
  closeAll: () => Promise<void>;
  update: { status: UpdateStatus | null; version: string | null; busy: boolean; error: string | null };
  updateAction: (action: UpdateAction) => Promise<void>;
};
const Context = createContext<Runtime | null>(null);

function updateError(message?: string) {
  if (message?.includes("профил")) return "Закройте открытые профили перед установкой обновления.";
  if (message?.includes("установленном приложении")) return "Обновления доступны только в установленном приложении.";
  return "Не удалось выполнить обновление. Проверьте подключение и повторите попытку.";
}

export function DesktopProfileProvider({ children }: { children: ReactNode }) {
  const launch = useServerFn(launchProfile);
  const close = useServerFn(closeProfile);
  const heartbeat = useServerFn(heartbeatProfile);
  const save = useServerFn(saveProfileSession);
  const saveSettings = useServerFn(saveBrowserSettings);
  const fetchSettings = useServerFn(fetchBrowserSettings);
  const api = useRef({ launch, close, heartbeat, save });
  api.current = { launch, close, heartbeat, save };
  const qc = useQueryClient();
  const [controller, setController] = useState<DesktopProfileLifecycle | null>(null);
  const lifecycleRef = useRef<DesktopProfileLifecycle | null>(null);
  const [ready, setReady] = useState(false);
  const [update, setUpdate] = useState<Runtime["update"]>({ status: null, version: null, busy: false, error: null });
  const updateBusy = useRef(false);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) { setReady(true); return; }
    const lifecycle = lifecycleRef.current ??= new DesktopProfileLifecycle(bridge, {
      launch: (profileId, device) => api.current.launch({ data: { profileId, device } }),
      close: (data) => api.current.close({ data }),
      heartbeat: (data) => api.current.heartbeat({ data }),
      save: (data) => api.current.save({ data }),
    });
    setController(lifecycle);
    let disposed = false;
    const invalidate = () => { if (!disposed) void qc.invalidateQueries({ queryKey: ["profiles"] }); };
    const off = bridge.onProfileClosed((event) => {
      void lifecycle.closed(event).catch(() => {}).finally(invalidate);
    });
    const synchronize = () => lifecycle.restore().then(() => lifecycle.sync()).catch(() => {}).finally(invalidate);
    void synchronize().finally(() => {
      if (!disposed) setReady(true);
    });
    const timer = window.setInterval(() => { void lifecycle.sync().catch(() => {}).finally(invalidate); }, 60_000);
    const reconnect = () => { void synchronize(); };
    window.addEventListener("online", reconnect);
    return () => {
      disposed = true;
      off();
      window.clearInterval(timer);
      window.removeEventListener("online", reconnect);
    };
  }, [qc]);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    const timers = new Map<string, number>();
    const revisions = new Map<string, number>();
    const pending = new Map<string, BrowserSettings>();
    const saving = new Set<string>();
    let disposed = false;
    const saveLatest = async (profileId: string) => {
      if (disposed || saving.has(profileId)) return;
      const value = pending.get(profileId);
      if (!value) return;
      saving.add(profileId);
      try {
        const saved = await saveSettings({ data: { ...value, revision: revisions.get(profileId) ?? value.revision } });
        if (pending.get(profileId) === value) pending.delete(profileId);
        revisions.set(profileId, saved.revision);
        if (!pending.has(profileId)) await bridge.pushBrowserSettings(saved);
      } catch {
        const remote = await fetchSettings({ data: { profileId } }).catch(() => null);
        if (remote) {
          revisions.set(profileId, remote.revision);
          try {
            const saved = await saveSettings({ data: { ...value, revision: remote.revision } });
            if (pending.get(profileId) === value) pending.delete(profileId);
            revisions.set(profileId, saved.revision);
            if (!pending.has(profileId)) await bridge.pushBrowserSettings(saved);
            return;
          } catch { /* сеть или повторный конфликт: сохраняем локальную очередь */ }
        }
      } finally {
        saving.delete(profileId);
        if (!disposed && pending.has(profileId)) {
          window.clearTimeout(timers.get(profileId));
          timers.set(profileId, window.setTimeout(() => void saveLatest(profileId), 2_000));
        }
      }
    };
    const off = bridge.onBrowserSettingsChanged((raw) => {
      const parsed = browserSettingsSchema.safeParse(raw);
      if (!parsed.success) return;
      pending.set(parsed.data.profileId, parsed.data);
      window.clearTimeout(timers.get(parsed.data.profileId));
      timers.set(parsed.data.profileId, window.setTimeout(() => void saveLatest(parsed.data.profileId), 500));
    });
    const channel = supabase.channel("profile-browser-settings")
      .on("postgres_changes", { event: "*", schema: "public", table: "profile_browser_settings" }, (event) => {
        const row = event.new as Record<string, unknown>;
        const parsed = browserSettingsSchema.safeParse({
          profileId: row["profile_id"], bookmarks: row["bookmarks"], bookmarkBarVisible: row["bookmark_bar_visible"],
          zoomLevel: row["zoom_level"], extensions: row["extensions"], revision: row["revision"], updatedAt: row["updated_at"],
          activeProxyId: row["active_proxy_id"] ?? null, proxyFailover: row["proxy_failover"] ?? false,
        });
        if (!parsed.success || pending.has(parsed.data.profileId) || parsed.data.revision <= (revisions.get(parsed.data.profileId) || 0)) return;
        revisions.set(parsed.data.profileId, parsed.data.revision);
        window.clearTimeout(timers.get(parsed.data.profileId));
        void bridge.pushBrowserSettings(parsed.data);
      }).subscribe();
    return () => {
      disposed = true;
      off();
      for (const timer of timers.values()) window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [fetchSettings, saveSettings]);

  useEffect(() => {
    const invalidateProfiles = () => { void qc.invalidateQueries({ queryKey: ["profiles"] }); };
    const invalidateProxies = () => {
      void qc.invalidateQueries({ queryKey: ["proxies"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
    };
    const invalidateBookmarks = () => { void qc.invalidateQueries({ queryKey: ["bookmark-defaults"] }); };
    const channel = supabase.channel("workspace-cloud-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "browser_profiles" }, invalidateProfiles)
      .on("postgres_changes", { event: "*", schema: "public", table: "proxies" }, invalidateProxies)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_bookmark_defaults" }, (event) => {
        invalidateBookmarks();
        const row = event.new as Record<string, unknown>;
        const parsed = bookmarkDefaultsSchema.safeParse({
          teamId: row["team_id"], bookmarks: row["bookmarks"], bookmarkBarVisible: row["bookmark_bar_visible"],
          revision: row["revision"], updatedAt: row["updated_at"],
        });
        if (parsed.success) void desktop()?.pushBookmarkDefaults?.(parsed.data).catch(() => {});
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [qc]);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    let disposed = false;
    let receivedEvent = false;
    const apply = (status: UpdateStatus) => {
      if (disposed) return;
      setUpdate((current) => ({ ...current,
        status: status.state === "error" ? { state: "error", error: updateError(status.error) } : status,
        error: status.state === "error" ? updateError(status.error) : null,
      }));
    };
    const off = bridge.onUpdateStatus((status) => { receivedEvent = true; apply(status); });
    void bridge.appVersion().then((version) => {
      if (!disposed) setUpdate((current) => ({ ...current, version }));
    }).catch(() => {
      if (!disposed) setUpdate((current) => ({ ...current, error: "Не удалось получить версию приложения." }));
    });
    void bridge.updateState().then((status) => { if (!receivedEvent) apply(status); }).catch(() => {
      if (!receivedEvent) apply({ state: "error", error: "" });
    });
    return () => { disposed = true; off(); };
  }, []);

  async function updateAction(action: UpdateAction) {
    const bridge = desktop();
    if (!bridge || updateBusy.current) return;
    updateBusy.current = true;
    setUpdate((current) => ({ ...current, busy: true, error: null }));
    try {
      if (action === "install" && (controller?.hasWork() || !ready)) {
        setUpdate((current) => ({ ...current, error: "Закройте профили и завершите синхронизацию перед установкой обновления." }));
        return;
      }
      const result = await (action === "check" ? bridge.checkUpdate() : action === "download" ? bridge.downloadUpdate() : bridge.installUpdate());
      if (!result.ok) setUpdate((current) => ({ ...current, error: updateError(result.error) }));
    } catch {
      setUpdate((current) => ({ ...current, error: updateError() }));
    } finally {
      updateBusy.current = false;
      setUpdate((current) => ({ ...current, busy: false }));
    }
  }

  async function start(id: string) {
    if (!controller || !ready) throw new Error("Запуск доступен в приложении Umbra для Windows после синхронизации.");
    try { await controller.start(id); }
    finally { void qc.invalidateQueries({ queryKey: ["profiles"] }); }
  }
  async function stop(id: string) {
    try { await controller?.stop(id); }
    finally { void qc.invalidateQueries({ queryKey: ["profiles"] }); }
  }
  return <Context.Provider value={{ ...state, available: !!controller, ready, start, stop,
    retry: async () => { try { await controller?.restore(); await controller?.sync(); } finally { void qc.invalidateQueries({ queryKey: ["profiles"] }); } },
    closeAll: async () => { await controller?.closeAll(); }, update, updateAction,
  }}>{children}</Context.Provider>;
}

export function useDesktopProfileLifecycle() {
  const value = useContext(Context);
  if (!value) throw new Error("DesktopProfileProvider is required");
  return value;
}
