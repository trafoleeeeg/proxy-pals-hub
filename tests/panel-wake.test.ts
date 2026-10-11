import { afterEach, expect, test } from "bun:test";
import { focusManager, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { ConnectionUnavailableError, connectionUnavailable, setConnectionUnavailable, showPanelReadError, subscribeConnection } from "../src/lib/panel-connectivity";
import { createPanelRecovery } from "../src/lib/panel-recovery";
import { PANEL_QUERY_DEFAULTS, recoverPanelQueries } from "../src/lib/panel-query-recovery";
import { createPanelWake } from "../src/lib/panel-wake";

afterEach(() => { setConnectionUnavailable(false); focusManager.setFocused(undefined); onlineManager.setOnline(true); });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function clock() {
  let time = 0, id = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  return {
    now: () => time,
    advance: (amount: number) => { time += amount; },
    schedule: ((callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id; }) as typeof setTimeout,
    cancel: ((timer: number) => { timers.delete(timer); }) as typeof clearTimeout,
    delays: () => [...timers.values()].map(timer => timer.delay),
    next: () => { const [key, timer] = [...timers][0]!; timers.delete(key); time += timer.delay; timer.callback(); },
  };
}

test("healthy native resume and multi-day timer gap refresh immediately without manufacturing offline", async () => {
  const fake = clock(); let checks = 0, reads = 0;
  const task = createPanelRecovery({ verify: async () => { checks++; return {}; }, recovered: async () => { reads++; }, expired: () => {} });
  const wake = createPanelWake({ run: task.run, needsRecovery: task.needsRecovery, visible: () => true, ...fake });
  try {
    wake.wake(true);
    expect(checks).toBe(1);
    expect(connectionUnavailable()).toBe(false);
    await settle(); expect(reads).toBe(1);
    fake.advance(3 * 86_400_000); wake.tick();
    expect(checks).toBe(2);
    expect(connectionUnavailable()).toBe(false);
    await settle(); expect(reads).toBe(2);
    expect(fake.delays()).toEqual([]);
  } finally { wake.dispose(); task.dispose(); }
});

test("focus, online, visibility and native wake coalesce while verification is pending", async () => {
  let complete!: (user: object) => void, checks = 0, reads = 0;
  const task = createPanelRecovery({ verify: () => { checks++; return new Promise(resolve => { complete = resolve; }); }, recovered: async () => { reads++; }, expired: () => {} });
  const wake = createPanelWake({ run: task.run, needsRecovery: task.needsRecovery, visible: () => true });
  try {
    wake.wake(); wake.wake(); wake.wake(true); wake.connectionChanged();
    expect(checks).toBe(1); expect(reads).toBe(0);
    complete({}); await settle();
    expect(reads).toBe(1);
  } finally { wake.dispose(); task.dispose(); }
});

test("real transient failure retries at 250ms, not the next 15s tick; hidden and disposed panels stay quiet", async () => {
  const fake = clock(); let checks = 0, available = false, visible = true;
  const task = createPanelRecovery({ verify: async () => { checks++; if (!available) throw new ConnectionUnavailableError(); return {}; }, recovered: async () => {}, expired: () => {} });
  const wake = createPanelWake({ run: task.run, needsRecovery: task.needsRecovery, visible: () => visible, ...fake });
  // The shared flag can change synchronously inside verification. Defer its
  // subscriber as the component does, so it cannot recursively start a task.
  const off = subscribeConnection(() => queueMicrotask(() => wake.connectionChanged()));
  try {
    wake.wake(true); await settle();
    expect(checks).toBe(1); expect(fake.delays()).toEqual([250]);
    available = true; fake.next(); await settle();
    expect(checks).toBe(2); expect(connectionUnavailable()).toBe(false);
    expect(fake.delays()).toEqual([]);
    available = false; wake.wake(true); await settle();
    visible = false; wake.wake();
    expect(fake.delays()).toEqual([]);
    fake.advance(86_400_000); wake.tick(); expect(checks).toBe(3);
    visible = true; available = true; wake.wake(true); await settle(); expect(checks).toBe(4);
    wake.dispose(); fake.advance(86_400_000); wake.tick(); expect(checks).toBe(4);
  } finally { off(); wake.dispose(); task.dispose(); }
});

test("backoff is bounded and application failures and expired sessions are not network retry loops", async () => {
  const fake = clock(); let state: "offline" | "failed" | "expired" = "offline", checks = 0, exits = 0;
  const task = createPanelRecovery({ verify: async () => { checks++; if (state === "offline") throw new ConnectionUnavailableError(); if (state === "failed") throw new Error("Access denied"); return null; }, recovered: async () => {}, expired: () => { exits++; } });
  const wake = createPanelWake({ run: task.run, needsRecovery: task.needsRecovery, visible: () => true, ...fake });
  try {
    wake.wake(true); await settle();
    for (const delay of [250, 750, 1500, 3000, 5000, 15000, 15000]) {
      expect(fake.delays()).toEqual([delay]); fake.next(); await settle();
    }
    state = "failed"; fake.next(); await settle(); expect(fake.delays()).toEqual([]);
    const stopped = checks; fake.advance(86_400_000); wake.tick(); await settle(); expect(checks).toBe(stopped);
    state = "expired"; expect((await wake.retry()).status).toBe("expired");
    expect(exits).toBe(1); expect(fake.delays()).toEqual([]);
  } finally { wake.dispose(); task.dispose(); }
});

test("query focus/reconnect cannot race wake auth; cached panel survives until fresh reads finish", async () => {
  const client = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS } });
  client.mount(); let verified = false, complete!: (user: object) => void;
  const events: string[] = [];
  const observers = ["permissions", "profiles", "proxies"].map(key => {
    client.setQueryData([key], ["cached"]);
    return new QueryObserver(client, { queryKey: [key], staleTime: 0, refetchOnMount: false, queryFn: async () => {
      expect(verified).toBe(true); events.push(key); return ["fresh"];
    } });
  });
  const offs = observers.map(observer => observer.subscribe(() => {}));
  const task = createPanelRecovery({
    verify: () => { events.push("verify"); return new Promise(resolve => { complete = resolve; }); }, expired: () => {},
    recovered: signal => recoverPanelQueries({ queryClient: client, signal, reloadRoutes: async () => {}, refreshWorkspace: async () => { events.push("workspace"); } }),
  });
  const wake = createPanelWake({ run: task.run, needsRecovery: task.needsRecovery, visible: () => true });
  try {
    focusManager.setFocused(false); onlineManager.setOnline(false);
    focusManager.setFocused(true); onlineManager.setOnline(true); wake.wake(true);
    await settle(); expect(events).toEqual(["verify"]);
    for (const observer of observers) expect(observer.getCurrentResult().data).toEqual(["cached"]);
    verified = true; complete({}); await settle();
    expect(events).toEqual(["verify", "workspace", "permissions", "profiles", "proxies"]);
    for (const observer of observers) expect(observer.getCurrentResult().data).toEqual(["fresh"]);
    expect(connectionUnavailable()).toBe(false);
  } finally { wake.dispose(); task.dispose(); offs.forEach(off => off()); client.unmount(); client.clear(); }
});

test("only cached transport failures suppress duplicate inline alerts; cold and application errors stay visible", () => {
  const network = new ConnectionUnavailableError();
  expect(showPanelReadError({ isError: true, error: network, data: ["cached"] })).toBe(false);
  expect(showPanelReadError({ isError: true, error: network, data: [] })).toBe(false);
  expect(showPanelReadError({ isError: true, error: network, data: undefined })).toBe(true);
  expect(showPanelReadError({ isError: true, error: new Error("Forbidden"), data: ["cached"] })).toBe(true);
  expect(showPanelReadError({ isError: false, error: null, data: [] })).toBe(false);
});
