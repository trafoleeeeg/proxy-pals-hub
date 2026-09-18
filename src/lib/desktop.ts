export type UpdateStatus =
  | { state: "none" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number; version?: string }
  | { state: "downloaded"; version: string }
  | { state: "error"; error: string };

export type LaunchPayload = {
  profileId: string;
  name: string;
  fingerprint: unknown;
  proxy: unknown;
  /** Полный список прокси команды с секретами: остаётся в основном процессе клиента. */
  proxies?: unknown;
  cookies: string;
  lockToken: string;
  cookiesUpdatedAt: string;
  deviceId?: string;
  browserSettings?: import("./browser-settings").BrowserSettings | null;
  bookmarkDefaults?: import("./bookmark-defaults").BookmarkDefaults;
};

export type RunningProfile = {
  profileId: string;
  name: string;
  lockToken?: string | null;
  cookiesUpdatedAt?: string | null;
  deviceId?: string | null;
};
export type InstalledExtension = { id: string; name: string; version: string; source?: "store" | "url"; url?: string };

export type ProfileRuntimeSnapshot = { profileId: string; cookies: string | null; lockToken?: string | null; cookiesUpdatedAt?: string | null; deviceId?: string | null };
export type ProfileClosed = ProfileRuntimeSnapshot & { snapshotId: string };

export type UmbraBridge = {
  isDesktop: true;
  version?: string;
  platform: string;
  launchProfile: (payload: LaunchPayload) => Promise<{ ok: boolean; error?: string }>;
  closeProfile: (profileId: string) => Promise<{ ok: boolean; error?: string } & Partial<ProfileRuntimeSnapshot>>;
  listRunningProfiles: () => Promise<{ ok: boolean; profiles: RunningProfile[]; error?: string }>;
  pendingProfileClosures: () => Promise<{ ok: boolean; profiles: ProfileClosed[] }>;
  acknowledgeProfileClosure: (snapshotId: string) => Promise<{ ok: boolean }>;
  archiveProfileClosure: (snapshotId: string) => Promise<{ ok: boolean }>;
  profileCookies: (profileId: string) => Promise<{ ok: boolean; cookies: string | null } & Partial<ProfileRuntimeSnapshot>>;
  onProfileClosed: (cb: (p: ProfileClosed) => void) => () => void;
  pushBrowserSettings: (settings: import("./browser-settings").BrowserSettings) => Promise<{ ok: boolean; error?: string }>;
  pushBookmarkDefaults?: (settings: import("./bookmark-defaults").BookmarkDefaults) => Promise<{ ok: boolean; error?: string }>;
  onBrowserSettingsChanged: (cb: (settings: import("./browser-settings").BrowserSettings) => void) => () => void;
  openExternal: (url: string) => Promise<{ ok: boolean }>;
  listExtensions?: () => Promise<{ ok: boolean; extensions?: InstalledExtension[]; error?: string }>;
  addExtension?: () => Promise<{ ok: boolean; extension?: InstalledExtension; failures?: number; error?: string }>;
  addExtensionFromUrl?: (url: string) => Promise<{ ok: boolean; extension?: InstalledExtension; failures?: number; error?: string }>;
  updateExtension?: (id: string) => Promise<{ ok: boolean; extension?: InstalledExtension; failures?: number; error?: string }>;
  removeExtension?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  readProxyClipboard?: () => Promise<string>;
  checkProxy?: (payload: {
    id: string;
    protocol: string;
    host: string;
    port: number;
    username: string | null;
    password: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    result?: {
      ok: boolean;
      ip?: string;
      country?: string;
      city?: string;
      latency?: number;
      error?: string;
    };
  }>;
  appVersion: () => Promise<string>;
  checkUpdate: () => Promise<{ ok: boolean; version?: string | null; current?: string; error?: string }>;
  updateState: () => Promise<UpdateStatus>;
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
  installUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void;
};

declare global {
  interface Window {
    umbra?: UmbraBridge;
  }
}

export function desktop(): UmbraBridge | null {
  if (typeof window === "undefined") return null;
  return window.umbra ?? null;
}

type SessionKey = { profileId: string; lockToken: string; deviceId?: string };
type TerminalClose = "access_revoked" | "lease_lost";
const DESKTOP_OPERATION_TIMEOUT_MS = 15_000;
async function withDesktopTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), DESKTOP_OPERATION_TIMEOUT_MS);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
function terminalClose(response: unknown): TerminalClose | null {
  if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== false || !("terminal" in response)) return null;
  return response.terminal === "access_revoked" || response.terminal === "lease_lost" ? response.terminal : null;
}
export type ProfileSessionApi = {
  launch: (profileId: string, device: string) => Promise<LaunchPayload>;
  heartbeat: (key: SessionKey) => Promise<unknown>;
  save: (data: SessionKey & { cookies: string }) => Promise<unknown>;
  close: (data: SessionKey & { cookies?: string }) => Promise<unknown>;
};

export type LifecycleSnapshot = {
  running: { profileId: string; name: string }[];
  busy: string[];
  pending: string[];
  errors: Record<string, string>;
  notices: Record<string, string>;
  restoring: boolean;
};

// Tokens and cookie snapshots stay inside this controller, never in query caches,
// browser settings, Realtime payloads or UI state. The encrypted server save is
// the cross-device synchronization channel for cookies.
export class DesktopProfileLifecycle {
  private sessions = new Map<string, RunningProfile>();
  private pending = new Map<string, SessionKey & { cookies?: string; snapshotId?: string; saved?: boolean; terminal?: TerminalClose }>();
  private completed = new Set<string>();
  private closedTokens = new Set<string>();
  private outboxFailures = new Set<string>();
  private jobs = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();
  private errors: Record<string, string> = {};
  private notices: Record<string, string> = {};
  private active = 0;
  private waiting: (() => void)[] = [];
  private restoring = false;
  private restoreJob: Promise<void> | undefined;
  private syncJob: Promise<void> | undefined;
  private shutdownJob: Promise<void> | undefined;
  private snapshot: LifecycleSnapshot = { running: [], busy: [], pending: [], errors: {}, notices: {}, restoring: false };

  constructor(private bridge: UmbraBridge, private api: ProfileSessionApi, private limit = 3) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit() {
    this.snapshot = {
      running: [...this.sessions.values()].map(({ profileId, name }) => ({ profileId, name })),
      busy: [...this.jobs.keys()], pending: [...new Set([...this.pending.values()].map((p) => p.profileId).concat([...this.outboxFailures]))],
      errors: { ...this.errors }, notices: { ...this.notices }, restoring: this.restoring,
    };
    this.listeners.forEach((listener) => listener());
  }

  private async bounded<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try { return await task(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private run<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.jobs.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.bounded(task));
    this.jobs.set(id, job);
    this.emit();
    void job.finally(() => {
      if (this.jobs.get(id) === job) this.jobs.delete(id);
      this.emit();
    }).catch(() => {});
    return job;
  }

  restore = (): Promise<void> => {
    if (this.restoreJob) return this.restoreJob;
    this.restoring = true;
    this.emit();
    const job = (async () => {
      try {
        const outbox = await withDesktopTimeout(this.bridge.pendingProfileClosures(), "Очередь сохранения не ответила вовремя");
        if (!outbox.ok) throw new Error("Не удалось прочитать ожидающие сессии.");
        // Mark only affected profiles as unavailable immediately. Uploading
        // their durable snapshots continues in sync() and must not hold the UI.
        this.outboxFailures = new Set(outbox.profiles.map((profile) => profile.profileId));
        const result = await withDesktopTimeout(this.bridge.listRunningProfiles(), "Приложение не ответило вовремя");
        if (!result.ok) throw new Error();
        for (const profile of result.profiles) {
          if (!this.jobs.has(profile.profileId) && (!profile.lockToken || !this.closedTokens.has(profile.lockToken))) this.sessions.set(profile.profileId, profile);
          if (!profile.lockToken) this.errors[profile.profileId] = "У профиля нет токена сессии. Закройте профиль и обновите приложение.";
        }
        delete this.errors["restore"];
      } catch {
        this.errors["restore"] = "Не удалось восстановить список открытых профилей. Повторите синхронизацию.";
        throw new Error(this.errors["restore"]);
      } finally {
        this.restoring = false;
        this.emit();
      }
    })();
    this.restoreJob = job;
    void job.finally(() => { this.restoreJob = undefined; }).catch(() => {});
    return job;
  };

  start = (profileId: string): Promise<void> => {
    if (this.shutdownJob || this.restoring || this.errors["restore"] || this.errors["outbox"]) return Promise.reject(new Error("Дождитесь синхронизации приложения."));
    if (this.jobs.has(profileId) || this.sessions.has(profileId)) return Promise.resolve();
    return this.run(profileId, async () => {
      if (this.outboxFailures.has(profileId) || [...this.pending.values()].some((p) => p.profileId === profileId)) throw new Error("Сначала сохраните предыдущую сессию профиля.");
      let payload: LaunchPayload | undefined;
      try {
        payload = await this.api.launch(profileId, this.bridge.platform);
        if (!payload.lockToken) throw new Error("Сервер не выдал токен сессии профиля.");
        this.sessions.set(profileId, {
          profileId, name: payload.name, lockToken: payload.lockToken, cookiesUpdatedAt: payload.cookiesUpdatedAt,
          ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
        });
        const result = await this.bridge.launchProfile(payload);
        if (!result.ok) throw new Error(result.error || "Приложение не смогло открыть окно профиля.");
        delete this.errors[profileId];
        delete this.notices[profileId];
      } catch (error) {
        this.sessions.delete(profileId);
        if (payload?.lockToken) {
          this.pending.set(payload.lockToken, { profileId, lockToken: payload.lockToken, ...(payload.deviceId ? { deviceId: payload.deviceId } : {}) });
          await this.flushClose(payload.lockToken).catch(() => {});
        }
        const reason = error instanceof Error && error.message.trim() ? error.message.trim() : "";
        this.errors[profileId] = payload && this.pending.has(payload.lockToken)
          ? "Запуск не выполнен. Снятие блокировки ожидает связи с сервером."
          : reason || "Не удалось запустить профиль. Проверьте доступ, блокировку и параметры подключения.";
        throw new Error(this.errors[profileId]);
      }
    });
  };

  private key(profile: RunningProfile): SessionKey {
    if (!profile.lockToken) throw new Error("Отсутствует токен сессии. Обновите приложение.");
    return { profileId: profile.profileId, lockToken: profile.lockToken, ...(profile.deviceId ? { deviceId: profile.deviceId } : {}) };
  }

  private async flushClose(token: string) {
    const data = this.pending.get(token);
    if (!data) return;
    try {
      if (!data.saved && !this.completed.has(token)) {
        const response = await this.api.close({ profileId: data.profileId, lockToken: data.lockToken, ...(data.deviceId ? { deviceId: data.deviceId } : {}),
          ...(typeof data.cookies === "string" ? { cookies: data.cookies } : {}) });
        const terminal = terminalClose(response);
        if (!terminal && (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true)) throw new Error();
        if (terminal) data.terminal = terminal;
        this.completed.add(token);
        this.closedTokens.add(data.lockToken);
        data.saved = true;
      }
      if (data.snapshotId) {
        const ack = data.terminal
          ? await this.bridge.archiveProfileClosure(data.snapshotId)
          : await this.bridge.acknowledgeProfileClosure(data.snapshotId);
        if (!ack.ok) throw new Error();
      }
      if (this.pending.get(token) === data) this.pending.delete(token);
      if (![...this.pending.values()].some((item) => item.profileId === data.profileId)) {
        this.outboxFailures.delete(data.profileId);
        delete this.errors[data.profileId];
        if (data.terminal && data.snapshotId) this.notices[data.profileId] = data.terminal === "access_revoked"
          ? "Доступ к профилю отозван. Cookies этой сессии сохранены только в локальном архиве и не загружены в облако."
          : "Сессия профиля больше не действует. Cookies сохранены только в локальном архиве и не загружены в облако.";
      }
    } catch {
      this.errors[data.profileId] = data.terminal
        ? "Сессия завершена сервером, но локальный архив cookies не подтверждён. Повторите синхронизацию перед выходом."
        : "Закрытие не подтверждено сервером. Возможны потеря связи или устаревший токен. Cookies ожидают синхронизации.";
      throw new Error(this.errors[data.profileId]);
    }
  }

  private async finish(event: ProfileClosed) {
    const current = this.sessions.get(event.profileId);
    const key = this.key({ ...event, name: "", ...(current && current.lockToken === event.lockToken && current.deviceId ? { deviceId: current.deviceId } : {}) });
    if (current?.lockToken === key.lockToken) this.sessions.delete(event.profileId);
    if (!this.pending.has(event.snapshotId)) this.pending.set(event.snapshotId, {
      ...key, ...(typeof event.cookies === "string" ? { cookies: event.cookies } : {}), snapshotId: event.snapshotId,
    });
    await this.flushClose(event.snapshotId);
  }

  closed = (event: ProfileClosed): Promise<void> => this.run(event.profileId, async () => {
    if (!event.lockToken || !event.snapshotId) {
      // Записи старых версий не содержат токена сессии: сервер не может их принять.
      // Переносим такую запись в локальный архив и разблокируем профиль.
      if (event.snapshotId && this.bridge.archiveProfileClosure) {
        try {
          const ack = await this.bridge.archiveProfileClosure(event.snapshotId);
          if (!ack.ok) throw new Error();
          this.outboxFailures.delete(event.profileId);
          delete this.errors[event.profileId];
          this.notices[event.profileId] = "Запись закрытия от прежней версии перенесена в локальный архив. Профиль снова доступен; cookies той сессии в облако не загружены.";
          this.emit();
          return;
        } catch {
          this.outboxFailures.add(event.profileId);
          this.errors[event.profileId] = "Не удалось перенести старую запись сессии в архив. Повторите синхронизацию.";
          throw new Error(this.errors[event.profileId]);
        }
      }
      this.outboxFailures.add(event.profileId);
      this.errors[event.profileId] = "Сохранённая сессия не содержит токен. Обновите приложение; запись оставлена для восстановления.";
      throw new Error(this.errors[event.profileId]);
    }
    // A delayed event can only close its own token, never a newer running session.
    await this.finish(event);
  });

  private async loadOutbox() {
    const result = await this.bridge.pendingProfileClosures();
    if (!result.ok) throw new Error("Не удалось прочитать ожидающие сессии.");
    delete this.errors["outbox"];
    const results = await Promise.allSettled(result.profiles.map((event) => this.closed(event)));
    this.outboxFailures = new Set(result.profiles.filter((_, i) => results[i]?.status === "rejected").map((p) => p.profileId));
    this.emit();
  }

  stop = (profileId: string): Promise<void> => this.run(profileId, async () => {
    const profile = this.sessions.get(profileId);
    if (!profile) {
      for (const [token, data] of this.pending) if (data.profileId === profileId) await this.flushClose(token);
      return;
    }
    try {
      const result = await this.bridge.closeProfile(profileId);
      if (!result.ok) throw new Error();
      if (result.lockToken && result.lockToken !== profile.lockToken) throw new Error();
      // Only durable records have an ID that main can acknowledge. A close reply
      // may be empty when the window closed before this queued request arrived.
      const outbox = await this.bridge.pendingProfileClosures();
      if (!outbox.ok) throw new Error();
      const records = outbox.profiles.filter((entry) => entry.profileId === profileId && entry.lockToken === profile.lockToken);
      if (!records.length) throw new Error();
      for (const record of records) await this.finish(record);
    } catch {
      this.errors[profileId] ??= "Не удалось закрыть профиль. Повторите попытку перед выходом.";
      throw new Error(this.errors[profileId]);
    }
  });

  sync = (): Promise<void> => {
    if (this.shutdownJob) return this.shutdownJob;
    if (this.syncJob) return this.syncJob;
    const job = (async () => {
      try { await this.loadOutbox(); delete this.errors["outbox"]; }
      catch { this.errors["outbox"] = "Не удалось прочитать очередь сохранения cookies. Повторите синхронизацию."; this.emit(); }
      const ids = [...new Set([...this.sessions.keys(), ...[...this.pending.values()].map((p) => p.profileId)])];
      await Promise.all(ids.map((id) => this.run(id, async () => {
        try {
          for (const [token, data] of this.pending) if (data.profileId === id) await this.flushClose(token).catch(() => {});
          const profile = this.sessions.get(id);
          if (!profile) return;
          const key = this.key(profile);
          await this.api.heartbeat(key);
          const snapshot = await this.bridge.profileCookies(id);
          if (!snapshot.ok || typeof snapshot.cookies !== "string" || snapshot.lockToken !== key.lockToken || (snapshot.profileId && snapshot.profileId !== id)) throw new Error();
          await this.api.save({ ...key, cookies: snapshot.cookies });
          if (![...this.pending.values()].some((p) => p.profileId === id) && !this.outboxFailures.has(id)) delete this.errors[id];
        } catch {
          this.errors[id] ??= "Нет подтверждения сохранения cookies или продления блокировки. Проверьте подключение.";
        }
      })));
    })();
    this.syncJob = job;
    void job.finally(() => { this.syncJob = undefined; }).catch(() => {});
    return job;
  };

  hasWork = () => this.sessions.size > 0 || this.pending.size > 0 || this.outboxFailures.size > 0 || this.jobs.size > 0 || this.restoring || !!this.errors["restore"] || !!this.errors["outbox"];

  closeAll = (): Promise<void> => {
    if (this.shutdownJob) return this.shutdownJob;
    const job = (async () => {
      if (this.restoreJob) await this.restoreJob;
      else if (this.errors["restore"]) await this.restore();
      if (this.syncJob) await this.syncJob;
      await Promise.allSettled([...this.jobs.values()]);
      await Promise.allSettled([...new Set([...this.sessions.keys(), ...[...this.pending.values()].map((p) => p.profileId)])].map(this.stop));
      await this.loadOutbox();
      if (this.sessions.size || this.pending.size || this.outboxFailures.size) throw new Error("Выход отложен: не все профили закрыты и сохранены.");
    })();
    this.shutdownJob = job;
    void job.finally(() => { this.shutdownJob = undefined; }).catch(() => {});
    return job;
  };
}
