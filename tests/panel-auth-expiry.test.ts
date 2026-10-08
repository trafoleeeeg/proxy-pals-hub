import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const lib = (name: string) => JSON.stringify(fileURLToPath(new URL(`../src/lib/${name}.ts`, import.meta.url)));
const modules: Record<string, string> = {
  entry: `export * from ${lib("auth-session")}; export * from ${lib("auth-errors")};
    export * from ${lib("panel-recovery")}; export * from ${lib("panel-connectivity")};
    export { state } from 'expiry-test:auth';`,
  auth: `export const state = { signOuts: 0, sessionPresent: true, refreshError: null, refreshEmpty: false };
    const user = { id: 'synthetic-user' };
    const session = { access_token: 'synthetic-token', expires_at: 1, user };
    export const recoverLegacyOwnerSession = async () => {};
    export const supabase = { auth: {
      getSession: async () => ({ data: { session: state.sessionPresent ? session : null }, error: null }),
      refreshSession: async () => ({ data: { session: state.refreshError || state.refreshEmpty ? null : session }, error: state.refreshError }),
      getUser: async () => ({ data: { user }, error: null }),
      signOut: async () => { state.signOuts++; state.sessionPresent = false; return { error: null }; },
    } };`,
};
const built = await Bun.build({ entrypoints: ["expiry-test:entry"], target: "bun", write: false,
  plugins: [{ name: "isolated-panel-auth-expiry", setup(build) {
    build.onResolve({ filter: /^expiry-test:/ }, ({ path }) => ({ path: path.slice(12), namespace: "expiry-test" }));
    build.onResolve({ filter: /^\.\/app-supabase$/ }, () => ({ path: "auth", namespace: "expiry-test" }));
    build.onLoad({ filter: /.*/, namespace: "expiry-test" }, ({ path }) => ({ contents: modules[path]!, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
  } }],
});
if (!built.success) throw new AggregateError(built.logs);
const fixtureUrl = "data:text/javascript;base64," + Buffer.from(await built.outputs[0]!.text()).toString("base64");
const api = await import(fixtureUrl);

afterEach(() => {
  api.state.signOuts = 0;
  api.state.sessionPresent = true;
  api.state.refreshError = null;
  api.state.refreshEmpty = false;
  api.setConnectionUnavailable(false);
});

test.each(["rejected", "empty"])("definitively %s refresh requests login once without an offline loop", async (failure) => {
  if (failure === "rejected") api.state.refreshError = { code: "refresh_token_not_found", status: 400 };
  else api.state.refreshEmpty = true;
  let exits = 0, refetches = 0;
  api.setConnectionUnavailable(true);
  const task = api.createPanelRecovery({
    verify: api.getAuthenticatedUser,
    recovered: async () => { refetches++; },
    expired: () => { exits++; },
  });
  try {
    const first = task.run();
    expect(task.run()).toBe(first);
    expect((await first).status).toBe("expired");
    expect(api.state.signOuts).toBe(1);
    expect(api.connectionUnavailable()).toBe(false);
    expect((await task.run()).status).toBe("expired");
    expect(exits).toBe(1);
    expect(refetches).toBe(0);
  } finally { task.dispose(); }
});

test("transient refresh failure stays offline without signout, then auto-recovers", async () => {
  api.state.refreshError = { status: 503, message: "Service unavailable" };
  let exits = 0, refetches = 0;
  const task = api.createPanelRecovery({
    verify: api.getAuthenticatedUser,
    recovered: async () => { refetches++; }, expired: () => { exits++; },
  });
  try {
    expect((await task.run()).status).toBe("offline");
    expect(api.connectionUnavailable()).toBe(true);
    expect(api.state.signOuts).toBe(0);
    expect(exits).toBe(0);
    api.state.refreshError = null;
    expect((await task.run()).status).toBe("recovered");
    expect(api.connectionUnavailable()).toBe(false);
    expect(api.state.signOuts).toBe(0);
    expect(exits).toBe(0);
    expect(refetches).toBe(1);
  } finally { task.dispose(); }
});

test("an expiry already raised by the route is eligible for automatic recovery", async () => {
  api.state.sessionPresent = false;
  let exits = 0;
  const task = api.createPanelRecovery({
    initialError: new api.SessionExpiredError(), verify: api.getAuthenticatedUser,
    recovered: async () => { throw new Error("must not refetch after expiry"); }, expired: () => { exits++; },
  });
  try {
    expect((await task.run()).status).toBe("expired");
    expect(exits).toBe(1);
    expect(api.connectionUnavailable()).toBe(false);
  } finally { task.dispose(); }
});
