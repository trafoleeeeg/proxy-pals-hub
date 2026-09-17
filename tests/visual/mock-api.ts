import { generateFingerprint } from "../../src/lib/fingerprint";
import type { LaunchPayload, ProfileClosed, RunningProfile, UmbraBridge, UpdateStatus } from "../../src/lib/desktop";

const scenario = new URLSearchParams(location.search).get("scenario");
const now = "2026-09-15T00:00:00Z";
const cookieText = JSON.stringify([{ domain: ".example.com", path: "/", name: "fixture", value: "mock-only", secure: true, httpOnly: true, expirationDate: 1900000000 }]);
const profiles = [
  { id: "p1", name: "Рабочий профиль", folder: "Работа", tags: ["Основной"] },
  { id: "p2", name: "Резервный профиль", folder: "Работа", tags: [] },
  { id: "p3", name: "Профиль без папки", folder: "", tags: [] },
  { id: "p4", name: "ОченьДлинноеНазвание".repeat(9), folder: "Папка".repeat(20), tags: ["Метка".repeat(15)] },
].map((profile) => ({ ...profile, teamId: "team-a", notes: "", proxy_id: null as string | null, fingerprint: generateFingerprint(), created_at: now, updated_at: now,
  lock: scenario === "locked" && profile.id === "p1" ? { userId: "other", expiresAt: "2099-01-01T00:00:00Z" } : null,
}));
profiles.push({ ...profiles[0]!, id: "p5", teamId: "team-b", name: "Профиль второй команды" });
const closedListeners = new Set<(event: ProfileClosed) => void>();
const updateListeners = new Set<(status: UpdateStatus) => void>();

export const fixture = {
  calls: [] as { method: string; data: any }[],
  failures: [] as string[],
  delay: 0,
  profiles,
  access: [] as { profile_id: string; user_id: string }[],
  running: [] as RunningProfile[],
  outbox: [] as ProfileClosed[],
  archived: [] as ProfileClosed[],
  update: { state: "none" } as UpdateStatus,
  cookies: cookieText,
  closedSubscriptions: () => closedListeners.size,
  emitUpdate(status: UpdateStatus) { this.update = status; updateListeners.forEach((listener) => listener(status)); },
  emitClosed(id: string) {
    const running = this.running.find((profile) => profile.profileId === id);
    const snapshot: ProfileClosed = { profileId: id, lockToken: running?.lockToken ?? `lease-${id}`, cookies: this.cookies, snapshotId: crypto.randomUUID() };
    this.outbox.push(snapshot); this.running = this.running.filter((profile) => profile.profileId !== id);
    closedListeners.forEach((listener) => listener(snapshot));
    return snapshot;
  },
};
declare global { interface Window { fixture: typeof fixture } }
window.fixture = fixture;

function api<T>(method: string, handler: (data: any) => T) {
  return async (input: { data?: any } = {}): Promise<Awaited<T>> => {
    fixture.calls.push({ method, data: structuredClone(input.data ?? {}) });
    if (fixture.delay) await new Promise((resolve) => setTimeout(resolve, fixture.delay));
    if (fixture.failures.includes(method)) throw new Error("Mock request failure");
    return structuredClone(await handler(input.data ?? {}));
  };
}
const workspaces = ["a", "b"].map((id) => ({ teamId: `team-${id}`, teamName: id === "a" ? "Основная команда" : "Вторая команда", role: scenario === "member" ? "member" : "owner", userId: "owner", email: "owner@example.com" }));
export const listWorkspaces = api("listWorkspaces", () => workspaces);
export const getWorkspace = api("getWorkspace", (data) => workspaces.find((team) => team.teamId === (data.teamId ?? "team-a"))!);
export const listProfiles = api("listProfiles", (data) => fixture.profiles.filter((profile) => profile.teamId === data.teamId));
export const listProxies = api("listProxies", () => [{
  id: "proxy-1", label: "Прокси Германия", protocol: "http", host: "proxy.example.com", port: 8080, country: "DE",
  last_check_ok: true, last_check_ip: "203.0.113.2", last_check_latency_ms: 140,
  rotationUrlConfigured: true, rotationStatus: "success", rotationPreviousIp: "203.0.113.1",
  rotationNewIp: "203.0.113.2", rotationChangedAt: now,
}]);
export const bulkUpdateProfiles = api("bulkUpdateProfiles", (data) => {
  for (const profile of fixture.profiles.filter((row) => row.teamId === data.teamId && data.ids.includes(row.id))) {
    const { proxyId, ...changes } = data.changes;
    Object.assign(profile, changes, proxyId !== undefined ? { proxy_id: proxyId } : {});
  }
  return { updated: data.ids.length };
});
export const bulkDeleteProfiles = api("bulkDeleteProfiles", (data) => { fixture.profiles = fixture.profiles.filter((row) => row.teamId !== data.teamId || !data.ids.includes(row.id)); return { deleted: data.ids.length }; });
export const saveProfile = api("saveProfile", (data) => {
  const existing = fixture.profiles.find((profile) => profile.id === data.id);
  const profile = { ...data, id: data.id ?? crypto.randomUUID(), proxy_id: data.proxyId, lock: null, created_at: now, updated_at: now };
  if (existing) Object.assign(existing, profile); else fixture.profiles.push(profile);
  return { id: profile.id };
});
export const bulkCreateProfiles = api("bulkCreateProfiles", (data) => {
  for (let i = 0; i < data.count; i++) fixture.profiles.push({ ...profiles[0]!, id: crypto.randomUUID(), name: `${data.prefix} ${i + 1}`, folder: data.folder, teamId: data.teamId, fingerprint: data.fingerprints[i] });
  return { added: data.count };
});
export const cloneProfile = api("cloneProfile", (data) => {
  const profile = fixture.profiles.find((row) => row.id === data.id)!;
  const id = crypto.randomUUID(); fixture.profiles.push({ ...profile, id, name: `${profile.name} (копия)` }); return { id };
});
export const importProfileCookies = api("importProfileCookies", (data) => { fixture.cookies = data.text; return { imported: 1 }; });
export const exportProfileCookies = api("exportProfileCookies", () => ({ cookies: fixture.cookies }));
export const listMembers = api("listMembers", () => ({ members: [
  { id: "m1", userId: "owner", role: "owner", email: "owner@example.com" },
  { id: "m2", userId: "staff", role: "member", email: "staff@example.com" },
], invites: [{ id: "invite-1", email: "verylongemailaddress".repeat(8) + "@example.com", token: "test-invite" }], access: fixture.access }));
export const setProfilesAccess = api("setProfilesAccess", (data) => {
  fixture.access = fixture.access.filter((row) => row.user_id !== data.userId || !data.profileIds.includes(row.profile_id));
  if (data.granted) fixture.access.push(...data.profileIds.map((profile_id: string) => ({ profile_id, user_id: data.userId })));
  return { updated: data.profileIds.length };
});
export const setProfileAccess = api("setProfileAccess", (data) => setProfilesAccess({ data: { ...data, profileIds: [data.profileId] } }));
export const listAudit = api("listAudit", () => [{ id: "audit-1", created_at: now, email: "owner@example.com", action: "profile.updated" }]);
export const createInvite = api("createInvite", () => ({ token: "test-invite" }));
export const revokeInvite = api("revokeInvite", () => ({ ok: true }));
export const removeMember = api("removeMember", () => ({ ok: true }));
export const launchProfile = api("launchProfile", (data): LaunchPayload => ({ profileId: data.profileId, name: fixture.profiles.find((profile) => profile.id === data.profileId)!.name, fingerprint: {}, proxy: null, cookies: fixture.cookies, lockToken: `lease-${data.profileId}`, cookiesUpdatedAt: now, deviceId: "mock-device" }));
export const closeProfile = api("closeProfile", () => ({ ok: true }));
export const heartbeatProfile = api("heartbeatProfile", () => ({ expiresAt: "2099-01-01T00:00:00Z" }));
export const saveProfileSession = api("saveProfileSession", () => ({ ok: true }));

const bridge: UmbraBridge = {
  isDesktop: true, platform: "win32",
  launchProfile: async (payload) => { fixture.running.push({ profileId: payload.profileId, name: payload.name, lockToken: payload.lockToken }); return { ok: true }; },
  closeProfile: async (id) => {
    const { snapshotId: _snapshotId, ...snapshot } = fixture.emitClosed(id);
    return { ok: true, ...snapshot };
  },
  listRunningProfiles: async () => ({ ok: true, profiles: structuredClone(fixture.running) }),
  pendingProfileClosures: async () => ({ ok: true, profiles: structuredClone(fixture.outbox) }),
  acknowledgeProfileClosure: async (id) => {
    fixture.calls.push({ method: "acknowledgeProfileClosure", data: { snapshotId: id } });
    fixture.outbox = fixture.outbox.filter((snapshot) => snapshot.snapshotId !== id); return { ok: true };
  },
  archiveProfileClosure: async (id) => {
    fixture.calls.push({ method: "archiveProfileClosure", data: { snapshotId: id } });
    const snapshot = fixture.outbox.find((item) => item.snapshotId === id);
    if (snapshot) {
      fixture.archived.push(snapshot);
      fixture.outbox = fixture.outbox.filter((item) => item.snapshotId !== id);
    }
    return { ok: !!snapshot || fixture.archived.some((item) => item.snapshotId === id) };
  },
  profileCookies: async (id) => ({ ok: true, profileId: id, cookies: fixture.cookies, lockToken: fixture.running.find((profile) => profile.profileId === id)?.lockToken ?? null }),
  onProfileClosed: (listener) => { closedListeners.add(listener); return () => { closedListeners.delete(listener); }; },
  openExternal: async () => ({ ok: true }), appVersion: async () => "0.4.0",
  checkUpdate: async () => { fixture.calls.push({ method: "checkUpdate", data: {} }); fixture.emitUpdate({ state: "available", version: "0.5.0" }); return { ok: true }; },
  updateState: async () => fixture.update,
  downloadUpdate: async () => { fixture.emitUpdate({ state: "downloading", percent: 50 }); return { ok: true }; },
  installUpdate: async () => { fixture.calls.push({ method: "installUpdate", data: {} }); return { ok: true }; },
  onUpdateStatus: (listener) => { updateListeners.add(listener); return () => { updateListeners.delete(listener); }; },
};
if (scenario !== "web") window.umbra = bridge;

export const saveProxy = api("saveProxy", () => ({ id: "proxy-1" }));
export const deleteProxy = api("deleteProxy", () => ({ ok: true }));
export const importProxies = api("importProxies", () => ({ added: 1, issues: [] }));
export const checkProxy = api("checkProxy", () => ({ error: "Проверка в Windows" }));
export const proxyForCheck = api("proxyForCheck", () => ({ id: "proxy-1", protocol: "http", host: "proxy.example", port: 8080, username: null, password: "" }));
export const recordProxyCheck = api("recordProxyCheck", () => ({ ok: true }));
export const rotateProxyIp = api("rotateProxyIp", () => ({ ok: true, previousIp: "203.0.113.1", requestedAt: new Date().toISOString() }));
if (scenario === "extensions") {
  bridge.listExtensions = async () => ({ ok: true, extensions: [{ id: "fixture-extension", name: "Пример расширения", version: "1.0" }] });
  bridge.addExtension = async () => ({ ok: true, extension: { id: "fixture-added", name: "Новое расширение", version: "2.0" } });
  bridge.removeExtension = async () => ({ ok: true });
}
bridge.readProxyClipboard = async () => "proxy.example:8080";
