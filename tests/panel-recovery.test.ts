import { afterEach, expect, test } from "bun:test";
import { boundedFetch, ConnectionUnavailableError, connectionUnavailable, recoverVerifiedUser, setConnectionUnavailable } from "../src/lib/panel-connectivity";
import { createPanelRecovery } from "../src/lib/panel-recovery";

afterEach(() => setConnectionUnavailable(false));

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
