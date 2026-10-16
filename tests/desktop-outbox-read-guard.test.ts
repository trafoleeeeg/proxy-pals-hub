import { expect, test } from "bun:test";
import { DesktopProfileLifecycle, type LaunchPayload, type ProfileClosed, type ProfileSessionApi, type RunningProfile, type UmbraBridge } from "../src/lib/desktop";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(running: RunningProfile[] = [], limit = 3) {
  const state = { unreadable: false, outbox: [] as ProfileClosed[], running, launches: [] as string[], nativeLaunches: [] as string[], heartbeats: [] as string[], saves: [] as string[] };
  const payload = (profileId: string): LaunchPayload => ({ profileId, name: profileId, fingerprint: {}, proxy: null, cookies: "[]", lockToken: `lease-${profileId}`, cookiesUpdatedAt: "2026-01-01T00:00:00Z" });
  const bridge = {
    isDesktop: true, platform: "win32",
    pendingProfileClosures: async () => ({ ok: !state.unreadable, profiles: state.unreadable ? [] : [...state.outbox] }),
    listRunningProfiles: async () => ({ ok: true, profiles: [...state.running] }),
    launchProfile: async (data: LaunchPayload) => { state.nativeLaunches.push(data.profileId); return { ok: true }; },
    acknowledgeProfileClosure: async (snapshotId: string) => { state.outbox = state.outbox.filter(entry => entry.snapshotId !== snapshotId); return { ok: true }; },
    profileCookies: async (profileId: string) => ({ ok: true, cookies: "[]", lockToken: `lease-${profileId}` }),
  } as unknown as UmbraBridge;
  const api: ProfileSessionApi = {
    launch: async profileId => { state.launches.push(profileId); return payload(profileId); },
    close: async () => ({ ok: true }),
    heartbeat: async key => { state.heartbeats.push(key.profileId); },
    save: async data => { state.saves.push(data.profileId); },
  };
  return { state, bridge, api, payload, controller: new DesktopProfileLifecycle(bridge, api, limit) };
}

test("unknown outbox blocks fresh launch before any cloud or native action until a successful retry", async () => {
  const f = fixture();
  f.state.unreadable = true;
  await f.controller.restore();
  await expect(f.controller.start("affected")).rejects.toThrow();
  await f.controller.sync();
  await expect(f.controller.start("affected")).rejects.toThrow();
  expect(f.state.launches).toEqual([]);
  expect(f.state.nativeLaunches).toEqual([]);
  expect(f.controller.getSnapshot().errors.outbox).toBeDefined();
  f.state.unreadable = false;
  await f.controller.sync();
  expect(f.controller.getSnapshot().errors.outbox).toBeUndefined();
  await f.controller.start("affected");
  expect(f.state.launches).toEqual(["affected"]);
  expect(f.state.nativeLaunches).toEqual(["affected"]);
});

test("unknown outbox keeps existing profiles visible and their heartbeat and saves usable", async () => {
  const f = fixture([{ profileId: "running", name: "Running", lockToken: "lease-running" }]);
  f.state.unreadable = true;
  await f.controller.restore();
  await f.controller.start("running");
  await f.controller.sync();
  expect(f.controller.getSnapshot().running).toEqual([{ profileId: "running", name: "Running" }]);
  expect(f.state.heartbeats).toEqual(["running"]);
  expect(f.state.saves).toEqual(["running"]);
  expect(f.state.launches).toEqual([]);
  expect(f.controller.getSnapshot().errors.outbox).toBeDefined();
});

test("a queued fresh launch rechecks an outbox failure before requesting its lease", async () => {
  const f = fixture([], 1);
  const entered = deferred<void>(), release = deferred<void>();
  f.api.launch = async profileId => {
    f.state.launches.push(profileId);
    if (profileId === "first") { entered.resolve(); await release.promise; }
    return f.payload(profileId);
  };
  const first = f.controller.start("first");
  await entered.promise;
  const queued = f.controller.start("affected");
  const outcome = queued.then(() => null, error => error);
  f.state.unreadable = true;
  await f.controller.sync();
  release.resolve();
  await first;
  expect(await outcome).toBeInstanceOf(Error);
  expect(f.state.launches).toEqual(["first"]);
  expect(f.state.nativeLaunches).toEqual(["first"]);
});

test("finishing an older successful sync cannot clear a newer outbox read failure", async () => {
  const f = fixture();
  f.state.outbox = [{ profileId: "previous", lockToken: "previous-lease", snapshotId: "previous-snapshot", cookies: "[]" }];
  await f.controller.restore();
  const entered = deferred<void>(), release = deferred<void>();
  f.api.close = async () => { entered.resolve(); await release.promise; return { ok: true }; };
  const sync = f.controller.sync();
  await entered.promise;
  f.state.unreadable = true;
  await f.controller.restore();
  expect(f.controller.getSnapshot().errors.outbox).toBeDefined();
  release.resolve();
  await sync;
  expect(f.controller.getSnapshot().errors.outbox).toBeDefined();
  await expect(f.controller.start("affected")).rejects.toThrow();
  expect(f.state.launches).toEqual([]);
});
