import { describe, expect, test } from "bun:test";
import { DesktopProfileLifecycle, type LaunchPayload, type ProfileClosed, type ProfileSessionApi, type RunningProfile, type UmbraBridge } from "../src/lib/desktop";

const payload = (id: string, token = `lease-${id}`): LaunchPayload => ({ profileId: id, name: `Profile ${id}`, fingerprint: {}, proxy: { password: "test-only-password" }, cookies: "test-only-cookies", lockToken: token, cookiesUpdatedAt: "2026-09-15T00:00:00Z" });
const event = (id: string, token = `lease-${id}`, snapshotId = `snapshot-${token}`): ProfileClosed => ({ profileId: id, lockToken: token, cookies: "[]", snapshotId });
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

function fixture(running: RunningProfile[] = []) {
  const state = { running: [...running], outbox: [] as ProfileClosed[], closeCalls: [] as { profileId: string; lockToken: string; cookies?: string }[], heartbeats: [] as string[], saves: [] as string[], launches: [] as LaunchPayload[], ackCalls: [] as string[], archiveCalls: [] as string[] };
  const bridge = {
    isDesktop: true, platform: "win32",
    launchProfile: async (data: LaunchPayload) => { state.launches.push(data); state.running.push({ profileId: data.profileId, name: data.name, lockToken: data.lockToken }); return { ok: true }; },
    closeProfile: async (id: string) => {
      const profile = state.running.find((item) => item.profileId === id);
      state.running = state.running.filter((item) => item.profileId !== id);
      const snapshot = event(id, profile?.lockToken);
      state.outbox.push(snapshot);
      return { ok: true, profileId: id, lockToken: snapshot.lockToken, cookies: snapshot.cookies };
    },
    listRunningProfiles: async () => ({ ok: true, profiles: [...state.running] }),
    pendingProfileClosures: async () => ({ ok: true, profiles: [...state.outbox] }),
    acknowledgeProfileClosure: async (id: string) => { state.ackCalls.push(id); state.outbox = state.outbox.filter((item) => item.snapshotId !== id); return { ok: true }; },
    archiveProfileClosure: async (id: string) => { state.archiveCalls.push(id); state.outbox = state.outbox.filter((item) => item.snapshotId !== id); return { ok: true }; },
    profileCookies: async (id: string) => ({ ok: true, cookies: "[]", lockToken: state.running.find((p) => p.profileId === id)?.lockToken }),
    onProfileClosed: () => () => {}, openExternal: async () => ({ ok: true }), appVersion: async () => "0.4.0",
    checkUpdate: async () => ({ ok: true }), updateState: async () => ({ state: "none" as const }),
    downloadUpdate: async () => ({ ok: true }), installUpdate: async () => ({ ok: true }), onUpdateStatus: () => () => {},
  } as UmbraBridge;
  const api: ProfileSessionApi = {
    launch: async (id) => payload(id),
    close: async (data) => { state.closeCalls.push(data); return { ok: true }; },
    heartbeat: async (key) => { state.heartbeats.push(key.lockToken); },
    save: async (data) => { state.saves.push(data.lockToken); },
  };
  const controller = new DesktopProfileLifecycle(bridge, api, 3);
  return { controller, state, bridge, api };
}

describe("desktop profile lifecycle", () => {
  test("restores running profiles and carries their token through heartbeat and save", async () => {
    const f = fixture([{ profileId: "a", name: "A", lockToken: "restored-lease" }]);
    await f.controller.restore(); await f.controller.sync();
    expect(f.controller.getSnapshot().running).toEqual([{ profileId: "a", name: "A" }]);
    expect(f.state.heartbeats).toEqual(["restored-lease"]);
    expect(f.state.saves).toEqual(["restored-lease"]);
  });

  test("launch passes cookies and token without exposing them in public state", async () => {
    const f = fixture();
    await f.controller.start("a");
    expect(f.state.launches[0]).toEqual(payload("a"));
    const publicState = JSON.stringify(f.controller.getSnapshot());
    for (const secret of ["lease-a", "test-only-cookies", "test-only-password"]) expect(publicState).not.toContain(secret);
  });

  test("failed launch releases its lease and does not echo desktop error details", async () => {
    const f = fixture();
    f.bridge.launchProfile = async () => ({ ok: false, error: "test-only-password" });
    await expect(f.controller.start("a")).rejects.toThrow();
    expect(f.state.closeCalls).toEqual([{ profileId: "a", lockToken: "lease-a" }]);
    expect(f.controller.getSnapshot().running).toHaveLength(0);
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("test-only-password");
  });

  test("failed lease release is retried before the same profile can launch", async () => {
    const f = fixture();
    f.bridge.launchProfile = async () => ({ ok: false });
    const close = f.api.close;
    f.api.close = async () => { throw new Error("offline"); };
    await expect(f.controller.start("a")).rejects.toThrow();
    expect(f.controller.getSnapshot().pending).toContain("a");
    await expect(f.controller.start("a")).rejects.toThrow();
    f.api.close = close;
    await f.controller.sync();
    expect(f.controller.getSnapshot().pending).toHaveLength(0);
  });

  test("launch concurrency is bounded and repeated clicks cannot acquire duplicate leases", async () => {
    const f = fixture();
    let active = 0; let maximum = 0; let acquired = 0;
    f.api.launch = async (id) => { active++; acquired++; maximum = Math.max(maximum, active); await pause(); active--; return payload(id); };
    await Promise.all([...Array.from({ length: 12 }, (_, i) => f.controller.start(String(i))), f.controller.start("0")]);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(acquired).toBe(12);
  });

  test("sync calls cannot overlap and snapshots from a different token are rejected", async () => {
    const f = fixture([{ profileId: "a", name: "A", lockToken: "lease-a" }]);
    await f.controller.restore();
    f.bridge.profileCookies = async () => { await pause(); return { ok: true, cookies: "[]", lockToken: "older-lease" }; };
    const first = f.controller.sync(); const second = f.controller.sync();
    expect(second).toBe(first); await first;
    expect(f.state.heartbeats).toHaveLength(1);
    expect(f.state.saves).toHaveLength(0);
    expect(f.controller.getSnapshot().errors["a"]).toBeDefined();
  });

  test("close events are serialized behind an in-flight cookie save", async () => {
    const f = fixture([{ profileId: "a", name: "A", lockToken: "lease-a" }]);
    await f.controller.restore();
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    f.api.save = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); };
    const sync = f.controller.sync(); await entered;
    const close = f.controller.closed(event("a"));
    expect(f.state.closeCalls).toHaveLength(0);
    release(); await sync; await close;
    expect(f.state.closeCalls).toHaveLength(1);
  });

  test("the close reply and its event save once and acknowledge only after cloud save", async () => {
    const f = fixture(); await f.controller.start("a");
    await f.controller.stop("a"); await f.controller.closed(event("a"));
    expect(f.state.closeCalls).toHaveLength(1);
    expect(f.state.ackCalls).toContain("snapshot-lease-a");
    expect(f.state.outbox).toHaveLength(0);
  });

  test("startup drains outbox and an acknowledgement failure does not repeat cloud close", async () => {
    const f = fixture(); f.state.outbox = [event("a")];
    const ack = f.bridge.acknowledgeProfileClosure;
    f.bridge.acknowledgeProfileClosure = async () => ({ ok: false });
    await f.controller.restore(); await f.controller.sync();
    expect(f.state.closeCalls).toHaveLength(1); expect(f.state.outbox).toHaveLength(1);
    f.bridge.acknowledgeProfileClosure = ack;
    await f.controller.sync();
    expect(f.state.closeCalls).toHaveLength(1); expect(f.state.outbox).toHaveLength(0);
  });

  test("restart after acknowledgement failure replays the exact durable snapshot against an idempotent close receipt", async () => {
    const f = fixture();
    f.state.outbox = [event("a")];
    const receipts = new Set<string>();
    let writes = 0;
    f.api.close = async (data) => {
      f.state.closeCalls.push(data);
      if (receipts.has(data.lockToken)) return { ok: true };
      receipts.add(data.lockToken); writes++;
      return { ok: true };
    };
    const ack = f.bridge.acknowledgeProfileClosure;
    f.bridge.acknowledgeProfileClosure = async () => ({ ok: false });
    await f.controller.restore(); await f.controller.sync();
    expect(f.state.outbox).toHaveLength(1);
    expect(writes).toBe(1);
    f.bridge.acknowledgeProfileClosure = ack;
    const restarted = new DesktopProfileLifecycle(f.bridge, f.api);
    await restarted.restore(); await restarted.sync();
    expect(f.state.closeCalls).toHaveLength(2);
    expect(f.state.closeCalls[1]).toEqual(f.state.closeCalls[0]);
    expect(writes).toBe(1);
    expect(f.state.ackCalls).toEqual(["snapshot-lease-a"]);
    expect(f.state.outbox).toHaveLength(0);
    expect(restarted.hasWork()).toBe(false);
  });

  test("terminal access revocation archives only the exact durable snapshot and allows sign-out", async () => {
    const f = fixture(); f.state.outbox = [event("a", "old-lease", "exact-snapshot")];
    f.api.close = async (data) => { f.state.closeCalls.push(data); return { ok: false, terminal: "access_revoked", cookiesUpdatedAt: null }; };
    await f.controller.restore(); await f.controller.sync();
    expect(f.state.closeCalls).toEqual([{ profileId: "a", lockToken: "old-lease", cookies: "[]" }]);
    expect(f.state.archiveCalls).toEqual(["exact-snapshot"]);
    expect(f.state.ackCalls).toEqual([]);
    expect(f.state.outbox).toHaveLength(0);
    expect(f.controller.getSnapshot().notices["a"]).toContain("локальном архиве");
    await f.controller.closeAll();
    expect(f.controller.hasWork()).toBe(false);
  });

  test("failed terminal archive retains outbox and retries archive without another cloud close", async () => {
    const f = fixture(); f.state.outbox = [event("a", "old-lease", "exact-snapshot")];
    f.api.close = async (data) => { f.state.closeCalls.push(data); return { ok: false, terminal: "lease_lost", cookiesUpdatedAt: null }; };
    const archive = f.bridge.archiveProfileClosure;
    f.bridge.archiveProfileClosure = async (id) => { f.state.archiveCalls.push(id); return { ok: false }; };
    await f.controller.restore();
    expect(f.controller.getSnapshot().pending).toContain("a");
    await expect(f.controller.closeAll()).rejects.toThrow();
    expect(f.state.outbox).toHaveLength(1);
    expect(f.state.ackCalls).toEqual([]);
    f.bridge.archiveProfileClosure = archive;
    await f.controller.sync();
    expect(f.state.closeCalls).toHaveLength(1);
    expect(f.state.archiveCalls).toContain("exact-snapshot");
    expect(f.state.outbox).toHaveLength(0);
    expect(f.controller.hasWork()).toBe(false);
  });

  test("restart after terminal archive failure replays the same snapshot ID", async () => {
    const f = fixture(); f.state.outbox = [event("a", "old-lease", "durable-id")];
    f.api.close = async (data) => { f.state.closeCalls.push(data); return { ok: false, terminal: "access_revoked", cookiesUpdatedAt: null }; };
    const archive = f.bridge.archiveProfileClosure;
    f.bridge.archiveProfileClosure = async () => ({ ok: false });
    await f.controller.restore(); await f.controller.sync();
    expect(f.state.outbox).toHaveLength(1);
    f.bridge.archiveProfileClosure = archive;
    const restarted = new DesktopProfileLifecycle(f.bridge, f.api);
    await restarted.restore(); await restarted.sync();
    expect(f.state.closeCalls).toHaveLength(2);
    expect(f.state.closeCalls[1]).toEqual(f.state.closeCalls[0]);
    expect(f.state.archiveCalls).toEqual(["durable-id"]);
    expect(f.state.ackCalls).toEqual([]);
    expect(f.state.outbox).toHaveLength(0);
    expect(restarted.hasWork()).toBe(false);
  });

  test("transient server close failure never archives the snapshot", async () => {
    const f = fixture(); f.state.outbox = [event("a")];
    f.api.close = async (data) => { f.state.closeCalls.push(data); throw new Error("offline"); };
    await f.controller.restore(); await f.controller.sync();
    expect(f.controller.getSnapshot().pending).toContain("a");
    expect(f.state.archiveCalls).toEqual([]);
    expect(f.state.ackCalls).toEqual([]);
    expect(f.state.outbox).toHaveLength(1);
  });

  test("missing server close receipt cannot acknowledge or archive durable cookies", async () => {
    const f = fixture(); f.state.outbox = [event("a")];
    f.api.close = async (data) => { f.state.closeCalls.push(data); };
    await f.controller.restore(); await f.controller.sync();
    expect(f.controller.getSnapshot().pending).toContain("a");
    expect(f.state.ackCalls).toEqual([]);
    expect(f.state.archiveCalls).toEqual([]);
    expect(f.state.outbox).toHaveLength(1);
  });

  test("an empty native close reply cannot discard cookies from a prior window close", async () => {
    const f = fixture([{ profileId: "a", name: "A", lockToken: "lease-a" }]);
    await f.controller.restore(); await f.controller.sync();
    f.state.running = [];
    f.state.outbox = [{ ...event("a"), cookies: '[{"name":"last","value":"cookie"}]' }];
    f.bridge.closeProfile = async () => ({ ok: true });
    await f.controller.stop("a");
    expect(f.state.closeCalls).toEqual([{ profileId: "a", lockToken: "lease-a", cookies: '[{"name":"last","value":"cookie"}]' }]);
    expect(f.state.ackCalls).toEqual(["snapshot-lease-a"]);
  });

  test("distinct durable IDs are never collapsed into a single acknowledgement", async () => {
    const f = fixture();
    f.state.outbox = [event("a", "lease-a", "snapshot-1"), event("a", "lease-a", "snapshot-2")];
    const ack = f.bridge.acknowledgeProfileClosure;
    f.bridge.acknowledgeProfileClosure = async () => ({ ok: false });
    await f.controller.restore();
    f.bridge.acknowledgeProfileClosure = ack;
    await f.controller.sync();
    expect(new Set(f.state.ackCalls)).toEqual(new Set(["snapshot-1", "snapshot-2"]));
    expect(f.state.outbox).toHaveLength(0);
    expect(f.controller.hasWork()).toBe(false);
  });

  test("a reply carrying another session's token cannot close the active lease", async () => {
    const f = fixture(); await f.controller.start("a");
    f.bridge.closeProfile = async () => ({ ok: true, profileId: "a", lockToken: "other-lease", cookies: "[]" });
    await expect(f.controller.stop("a")).rejects.toThrow();
    expect(f.state.closeCalls).toHaveLength(0);
    expect(f.controller.getSnapshot().running).toHaveLength(1);
  });

  test("device identity returned by launch accompanies saves and durable close", async () => {
    const f = fixture();
    f.api.launch = async (id) => ({ ...payload(id), deviceId: "device-1" });
    const saved: unknown[] = [];
    f.api.save = async (data) => { saved.push(data); };
    await f.controller.start("a"); await f.controller.sync(); await f.controller.stop("a");
    expect(saved).toEqual([{ profileId: "a", lockToken: "lease-a", deviceId: "device-1", cookies: "[]" }]);
    expect(f.state.closeCalls[0]).toEqual({ profileId: "a", lockToken: "lease-a", deviceId: "device-1", cookies: "[]" });
  });

  test("unreadable durable storage blocks new launches until synchronization recovers", async () => {
    const f = fixture();
    const read = f.bridge.pendingProfileClosures;
    f.bridge.pendingProfileClosures = async () => ({ ok: false, profiles: [] });
    await f.controller.sync();
    await expect(f.controller.start("a")).rejects.toThrow();
    await expect(f.controller.closeAll()).rejects.toThrow();
    expect(f.controller.hasWork()).toBe(true);
    f.bridge.pendingProfileClosures = read;
    await f.controller.sync();
    expect(f.controller.hasWork()).toBe(false);
  });

  test("a stale outbox token is never replaced by the live lease and does not starve heartbeat", async () => {
    const f = fixture([{ profileId: "a", name: "A", lockToken: "new-lease" }]);
    f.state.outbox = [event("a", "old-lease")];
    f.api.close = async (data) => { f.state.closeCalls.push(data); throw new Error("stale token"); };
    await f.controller.restore(); await f.controller.sync();
    expect(f.state.closeCalls.every((call) => call.lockToken === "old-lease")).toBe(true);
    expect(f.state.heartbeats).toEqual(["new-lease"]);
    expect(f.state.saves).toEqual(["new-lease"]);
    expect(f.controller.getSnapshot().running).toHaveLength(1);
    expect(f.controller.getSnapshot().errors["a"]).toBeDefined();
    expect(f.state.ackCalls).toHaveLength(0);
  });

  test("outbox records without a token are archived locally and stop blocking the profile", async () => {
    const f = fixture(); f.state.outbox = [{ profileId: "a", cookies: "[]", snapshotId: "old-client" }];
    await f.controller.restore(); await f.controller.sync();
    expect(f.state.closeCalls).toHaveLength(0); expect(f.state.ackCalls).toHaveLength(0);
    expect(f.state.archiveCalls).toContain("old-client");
    expect(Object.values(f.controller.getSnapshot().notices).join(" ")).toContain("архив");
    expect(f.controller.getSnapshot().pending).toHaveLength(0);
  });

  test("failed native close keeps its lease and blocks account sign-out", async () => {
    const f = fixture(); await f.controller.start("a");
    f.bridge.closeProfile = async () => ({ ok: false, error: "test-only-secret" });
    await expect(f.controller.closeAll()).rejects.toThrow();
    expect(f.controller.getSnapshot().running).toHaveLength(1);
    expect(f.state.closeCalls).toHaveLength(0);
  });

  test("closeAll waits for a launch already in flight and rejects new starts", async () => {
    const f = fixture();
    f.api.launch = async (id) => { await pause(); return payload(id); };
    const launch = f.controller.start("a"); const shutdown = f.controller.closeAll();
    await expect(f.controller.start("b")).rejects.toThrow();
    await launch; await shutdown;
    expect(f.controller.hasWork()).toBe(false);
    expect(f.state.closeCalls).toHaveLength(1);
  });

  test("restoration failure blocks launch and retry recovers", async () => {
    const f = fixture(); const list = f.bridge.listRunningProfiles;
    f.bridge.listRunningProfiles = async () => { throw new Error("offline"); };
    await expect(f.controller.restore()).rejects.toThrow();
    await expect(f.controller.start("a")).rejects.toThrow();
    f.bridge.listRunningProfiles = list;
    await f.controller.restore(); await f.controller.start("a");
    expect(f.controller.getSnapshot().running).toHaveLength(1);
  });
});
