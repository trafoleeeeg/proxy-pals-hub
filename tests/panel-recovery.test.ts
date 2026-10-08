import { afterEach, expect, test } from "bun:test";
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { boundedFetch, panelRpcFetch, ConnectionUnavailableError, connectionUnavailable, recoverVerifiedUser, setConnectionUnavailable } from "../src/lib/panel-connectivity";
import { assertPanelRoutesReady, createPanelRecovery } from "../src/lib/panel-recovery";

afterEach(() => setConnectionUnavailable(false));

test("a resolved router invalidation with a failed route cannot declare recovery", async () => {
  let online = false, resets = 0;
  const root = createRootRoute();
  const app = createRoute({
    getParentRoute: () => root, path: "/app",
    beforeLoad: () => { if (!online) throw new ConnectionUnavailableError(); },
  });
  const router = createRouter({
    routeTree: root.addChildren([app]),
    history: createMemoryHistory({ initialEntries: ["/app"] }),
  });
  await router.load();
  const task = createPanelRecovery({
    verify: async () => ({ id: "owner" }),
    recovered: async () => {
      await router.invalidate({ sync: true });
      assertPanelRoutesReady(router.state.matches);
      resets++;
    },
    expired: () => { throw new Error("must not sign out on a route failure"); },
  });
  expect((await task.run()).status).toBe("offline");
  expect(connectionUnavailable()).toBe(true);
  expect(resets).toBe(0);
  online = true;
  expect((await task.run()).status).toBe("recovered");
  expect(connectionUnavailable()).toBe(false);
  expect(resets).toBe(1);
  task.dispose();
});

test("application errors are reported separately and explicit retry refetches while online", async () => {
  let fails = true, checks = 0, refetches = 0, exits = 0;
  const error = new Error("Server function not found");
  setConnectionUnavailable(true);
  const task = createPanelRecovery({
    verify: async () => { checks++; return { id: "owner" }; },
    recovered: async () => { refetches++; if (fails) throw error; },
    expired: () => { exits++; },
  });
  expect(await task.run()).toEqual({ status: "failed", error });
  expect(connectionUnavailable()).toBe(false);
  expect((await task.run()).status).toBe("skipped");
  expect(checks).toBe(1);
  expect(refetches).toBe(1);
  expect(await task.run({ retry: true })).toEqual({ status: "failed", error });
  expect(refetches).toBe(2);
  fails = false;
  expect((await task.run({ retry: true })).status).toBe("recovered");
  expect(refetches).toBe(3);
  expect(connectionUnavailable()).toBe(false);
  expect(exits).toBe(0);
  task.dispose();
});

test("an initial application error waits for explicit retry and can become a network retry", async () => {
  let online = false, refetches = 0;
  const task = createPanelRecovery({
    initialError: new Error("Unable to load panel"),
    verify: async () => { if (!online) throw new ConnectionUnavailableError(); return { id: "owner" }; },
    recovered: async () => { refetches++; }, expired: () => {},
  });
  expect((await task.run()).status).toBe("skipped");
  expect((await task.run({ retry: true })).status).toBe("offline");
  expect(connectionUnavailable()).toBe(true);
  online = true;
  expect((await task.run()).status).toBe("recovered");
  expect(refetches).toBe(1);
  expect(connectionUnavailable()).toBe(false);
  task.dispose();
});

test("resume during a coalesced online auth check still refetches the workspace", async () => {
  let complete!: (value: unknown) => void, refetches = 0;
  const task = createPanelRecovery({
    verify: () => new Promise((resolve) => { complete = resolve; }),
    recovered: async () => { refetches++; }, expired: () => {},
  });
  const focus = task.run();
  setConnectionUnavailable(true);
  expect(task.run()).toBe(focus);
  complete({ id: "owner" }); await focus;
  expect(refetches).toBe(1);
  expect(connectionUnavailable()).toBe(false);
  task.dispose();
});

test("hung recovery releases its slot, aborts refetch, and ignores late completion", async () => {
  let complete!: () => void;
  let refetches = 0, checks = 0;
  let abandoned: AbortSignal | undefined;
  setConnectionUnavailable(true);
  const task = createPanelRecovery({
    timeoutMs: 10,
    verify: async () => { checks++; return { id: "owner" }; },
    recovered: (signal) => {
      if (++refetches === 1) { abandoned = signal; return new Promise<void>((resolve) => { complete = resolve; }); }
      return Promise.resolve();
    },
    expired: () => { throw new Error("must not sign out on network failure"); },
  });
  await task.run();
  expect(abandoned?.aborted).toBe(true);
  expect(connectionUnavailable()).toBe(true);
  await task.run();
  expect(checks).toBe(2);
  expect(connectionUnavailable()).toBe(false);
  setConnectionUnavailable(true);
  complete();
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(connectionUnavailable()).toBe(true);
  task.dispose();
});

test("hung verification cannot block recovery or sign out on a late null result", async () => {
  let complete!: (value: unknown) => void;
  let checks = 0, exits = 0;
  setConnectionUnavailable(true);
  const task = createPanelRecovery({
    timeoutMs: 5,
    verify: () => ++checks === 1 ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve({ id: "owner" }),
    recovered: async () => {}, expired: () => { exits++; },
  });
  await task.run(); await task.run(); complete(null);
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(checks).toBe(2); expect(exits).toBe(0); expect(connectionUnavailable()).toBe(false);
  task.dispose();
});

test("RPC body stalls are aborted, not replayed; a fresh request succeeds", async () => {
  let signal: AbortSignal | undefined, attempts = 0;
  const hung: typeof fetch = async (_input, init) => {
    attempts++; signal = init?.signal ?? undefined;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } }));
  };
  await expect(panelRpcFetch("https://panel.example.test/_serverFn/test", undefined, 5, hung)).rejects.toBeInstanceOf(ConnectionUnavailableError);
  expect(attempts).toBe(1); expect(signal?.aborted).toBe(true); expect(connectionUnavailable()).toBe(true);
  const healthy: typeof fetch = async () => new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
  expect(await (await panelRpcFetch("https://panel.example.test/_serverFn/test", undefined, 50, healthy)).json()).toEqual({ ok: true });
});

test("RPC distinguishes gateway failure from denied access and caller cancellation", async () => {
  for (const status of [502, 503, 504]) {
    await expect(panelRpcFetch("https://panel.example.test/rpc", undefined, 50, async () => new Response(null, { status }))).rejects.toBeInstanceOf(ConnectionUnavailableError);
  }
  setConnectionUnavailable(false);
  for (const status of [401, 403]) {
    expect((await panelRpcFetch("https://panel.example.test/rpc", undefined, 50, async () => new Response(null, { status }))).status).toBe(status);
    expect(connectionUnavailable()).toBe(false);
  }
  const caller = new AbortController(); caller.abort();
  await expect(panelRpcFetch("https://panel.example.test/rpc", { signal: caller.signal }, 50, async () => { throw new DOMException("Cancelled", "AbortError"); })).rejects.toThrow("Cancelled");
  expect(connectionUnavailable()).toBe(false);
});

test("a timed-out auth request is aborted and the next request can succeed", async () => {
  let signal: AbortSignal | undefined;
  const hung: typeof fetch = async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise(() => {});
  };
  await expect(boundedFetch("https://auth.example.test/token", undefined, 5, hung)).rejects.toThrow("Request timed out");
  expect(signal?.aborted).toBe(true);
  const healthy: typeof fetch = async () => new Response("ok");
  expect(await (await boundedFetch("https://auth.example.test/token", undefined, 50, healthy)).text()).toBe("ok");
});

test("successful requests clear deadlines and respect caller cancellation", async () => {
  let signal: AbortSignal | undefined;
  const caller = new AbortController();
  await boundedFetch("https://auth.example.test/token", { signal: caller.signal }, 5, async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Response(null, { status: 204 });
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(signal?.aborted).toBe(false);
  caller.abort();
  expect(signal?.aborted).toBe(true);
});

test("cached verified UI remains mounted only for transient errors, never rejected credentials", async () => {
  const owner = { id: "owner" };
  const offline = async () => { throw new ConnectionUnavailableError(); };
  expect(await recoverVerifiedUser(offline, owner)).toBe(owner);
  await expect(recoverVerifiedUser(offline, undefined)).rejects.toThrow();
  await expect(recoverVerifiedUser(async () => { throw new Error("invalid session"); }, owner)).rejects.toThrow("invalid session");
  expect(await recoverVerifiedUser(async () => null, owner)).toBeNull();
});

test("repeated offline attempts recover the same panel after simulated days of inactivity", async () => {
  let online = false, attempts = 0, reloads = 0, exits = 0;
  const task = createPanelRecovery({
    verify: async () => { attempts++; if (!online) throw new ConnectionUnavailableError(); return { id: "employee" }; },
    recovered: async () => { reloads++; }, expired: () => { exits++; },
  });
  await task.run();
  await task.run();
  expect(connectionUnavailable()).toBe(true);
  expect(reloads).toBe(0);
  expect(exits).toBe(0);
  // Elapsed wall-clock duration does not invalidate the recovery controller.
  const original = Date.now;
  Date.now = () => original() + 3 * 24 * 60 * 60 * 1000;
  try { online = true; await task.run(); }
  finally { Date.now = original; }
  expect(connectionUnavailable()).toBe(false);
  expect(reloads).toBe(1);
  expect(exits).toBe(0);
  expect(attempts).toBe(3);
  task.dispose();
});

test("online/focus/visibility events coalesce and late results after disposal do nothing", async () => {
  let complete!: (value: unknown) => void;
  let attempts = 0, reloads = 0, exits = 0;
  setConnectionUnavailable(true);
  const task = createPanelRecovery({
    verify: () => { attempts++; return new Promise((resolve) => { complete = resolve; }); },
    recovered: async () => { reloads++; }, expired: () => { exits++; },
  });
  const first = task.run();
  const second = task.run();
  const third = task.run();
  expect(first).toBe(second);
  expect(second).toBe(third);
  expect(attempts).toBe(1);
  task.dispose(); complete({ id: "owner" }); await first;
  expect(reloads).toBe(0);
  expect(exits).toBe(0);
  expect(connectionUnavailable()).toBe(true);
});

test("definitively expired sessions request login, not cached access; explicit sign-in pauses recovery", async () => {
  let paused = true, checks = 0, exits = 0;
  const task = createPanelRecovery({
    verify: async () => { checks++; return null; }, recovered: async () => { throw new Error("must not restore access"); },
    expired: () => { exits++; }, paused: () => paused,
  });
  await task.run(); expect(checks).toBe(0);
  paused = false; await task.run();
  expect(checks).toBe(1); expect(exits).toBe(1);
  task.dispose();
});
