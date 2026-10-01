import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearEmployeePreview, employeeAuthKey, EMPLOYEE_PREVIEW_KEY, LEGACY_PREVIEW_KEY, queueEmployeeExit, readEmployeePreview, saveEmployeePreview, takeEmployeeExit } from "../src/lib/employee-session-storage";

const ownerId = "10000000-0000-4000-8000-000000000001";
const employeeId = "10000000-0000-4000-8000-000000000002";
const teamId = "20000000-0000-4000-8000-000000000001";
const preview = { ownerId, employeeId, teamId, employeeEmail: "employee@example.test" };

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
type Store = ReturnType<typeof storage>;
const source = fileURLToPath(new URL("../src/lib/app-supabase.ts", import.meta.url));
const stub = `
  export const state = { primaryUserId: ${JSON.stringify(ownerId)}, primarySets: [], primarySignouts: [], clients: [] };
  export const supabase = { auth: {
    getSession: async () => ({ error: null, data: { session: state.primaryUserId ? { user: { id: state.primaryUserId } } : null } }),
    setSession: async tokens => { state.primarySets.push(tokens); state.primaryUserId = tokens.access_token; return { error: null, data: { user: { id: tokens.access_token } } }; },
    signOut: async options => { state.primarySignouts.push(options); state.primaryUserId = null; return { error: null }; }
  } };
  export function createClient(url, key, options) {
    const storage = options.auth.storage, storageKey = options.auth.storageKey;
    const client = { options, realtime: { disconnect: async () => {} }, auth: {
      getSession: async () => ({ error: null, data: { session: JSON.parse(storage.getItem(storageKey) || 'null') } }),
      setSession: async tokens => { const session = { ...tokens, user: { id: tokens.access_token } }; storage.setItem(storageKey, JSON.stringify(session)); return { error: null, data: { user: session.user } }; },
      signOut: async () => { storage.removeItem(storageKey); return { error: null }; }, stopAutoRefresh: async () => {}
    } }; state.clients.push(client); return client;
  }
`;
const built = await Bun.build({
  entrypoints: ["employee-test:entry"], target: "bun", write: false,
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://auth.example.test", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture" }) },
  plugins: [{ name: "isolated-employee-auth", setup(build) {
    build.onResolve({ filter: /^employee-test:entry$/ }, () => ({ path: "entry", namespace: "employee-test" }));
    build.onResolve({ filter: /^@supabase\/supabase-js$|^@\/integrations\/supabase\/client$/ }, () => ({ path: "stub", namespace: "employee-test" }));
    build.onLoad({ filter: /.*/, namespace: "employee-test" }, ({ path }) => ({ contents: path === "stub" ? stub : `export * from ${JSON.stringify(source)}; export { state } from "@supabase/supabase-js";`, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
  } }],
});
if (!built.success) throw new AggregateError(built.logs, "Employee auth test bundle failed");
const bundleDir = mkdtempSync(join(tmpdir(), "umbra-employee-test-"));
const bundleText = await built.outputs[0]!.text();
async function load(store: Store) {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: store, configurable: true });
  // A distinct file recreates the module state of a new browser document.
  // Bun caches imports by file path even when their query strings differ.
  const bundle = join(bundleDir, `fixture-${crypto.randomUUID()}.js`);
  writeFileSync(bundle, bundleText);
  return import(pathToFileURL(bundle).href);
}
afterEach(() => { Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "sessionStorage"); });

describe("temporary employee identity", () => {
  test("enter/reload/restart leaves the primary login untouched and chooses employee credentials only in the current window", async () => {
    const store = storage();
    const first = await load(store);
    expect((await first.supabase.auth.getSession()).data.session.user.id).toBe(ownerId);
    await first.beginEmployeePreview(preview, { access_token: employeeId, refresh_token: "synthetic-employee-refresh" });
    expect(first.state.primarySets).toEqual([]);
    expect(first.state.primarySignouts).toEqual([]);
    expect(first.state.primaryUserId).toBe(ownerId);
    expect(store.getItem(EMPLOYEE_PREVIEW_KEY)).not.toContain("refresh");
    expect(store.getItem(EMPLOYEE_PREVIEW_KEY)).not.toContain("ownerAccessToken");
    const reloaded = await load(store);
    expect((await reloaded.supabase.auth.getSession()).data.session.user.id).toBe(employeeId);
    expect(reloaded.employeePreview()).toEqual(preview);
    expect(reloaded.state.clients[0].options.auth.detectSessionInUrl).toBe(false);
    const restarted = await load(storage());
    expect((await restarted.supabase.auth.getSession()).data.session.user.id).toBe(ownerId);
    expect(restarted.employeePreview()).toBeNull();
  });
  test("a real employee login has no return-to-owner preview", async () => {
    const api = await load(storage()); api.state.primaryUserId = employeeId;
    expect((await api.supabase.auth.getSession()).data.session.user.id).toBe(employeeId);
    expect(api.employeePreview()).toBeNull();
    await expect(api.beginEmployeePreview(preview, { access_token: employeeId, refresh_token: "synthetic" })).rejects.toThrow("владельца");
    expect(api.state.clients).toHaveLength(0);
  });
  test("manual return preserves the owner and cannot elevate already selected employee requests", async () => {
    const store = storage();
    saveEmployeePreview(store, preview);
    store.setItem(employeeAuthKey(preview), JSON.stringify({ user: { id: employeeId } }));
    const api = await load(store);
    expect((await api.supabase.auth.getSession()).data.session.user.id).toBe(employeeId);
    await api.leaveEmployeePreview();
    expect(api.employeePreview()).toBeNull();
    expect((await api.supabase.auth.getSession()).data.session).toBeNull();
    expect(api.state.primarySignouts).toEqual([]);
    const returned = await load(store);
    expect((await returned.supabase.auth.getSession()).data.session.user.id).toBe(ownerId);
  });
  test("expired employee auth does not fall back to owner rights in the same document", async () => {
    const store = storage(); saveEmployeePreview(store, preview);
    const api = await load(store);
    expect((await api.supabase.auth.getSession()).data.session).toBeNull();
    clearEmployeePreview(store);
    expect((await api.supabase.auth.getSession()).data.session).toBeNull();
    expect(api.state.primaryUserId).toBe(ownerId);
  });
  test("failed switch removes temporary credentials without replacing/logging out the primary identity", async () => {
    const store = storage(); const api = await load(store);
    await expect(api.beginEmployeePreview(preview, { access_token: ownerId, refresh_token: "wrong-synthetic-session" })).rejects.toThrow("переключиться");
    expect(store.values.size).toBe(0);
    expect(api.state.primarySets).toEqual([]);
    expect(api.state.primaryUserId).toBe(ownerId);
  });
  test("surviving legacy escrow restores the owner once; a rejected escrow leads to login", async () => {
    const store = storage();
    store.setItem(LEGACY_PREVIEW_KEY, JSON.stringify({ ownerAccessToken: ownerId, ownerRefreshToken: "synthetic-owner-refresh", ownerId }));
    const api = await load(store); api.state.primaryUserId = employeeId;
    await api.recoverLegacyOwnerSession(); await api.recoverLegacyOwnerSession();
    expect(api.state.primarySets).toHaveLength(1);
    expect(api.state.primaryUserId).toBe(ownerId);
    expect(store.getItem(LEGACY_PREVIEW_KEY)).toBeNull();
    store.setItem(LEGACY_PREVIEW_KEY, JSON.stringify({ ownerAccessToken: employeeId, ownerRefreshToken: "bad-synthetic", ownerId }));
    const rejected = await load(store); await rejected.recoverLegacyOwnerSession();
    expect(rejected.state.primaryUserId).toBeNull();
    expect(rejected.state.primarySignouts).toEqual([{ scope: "local" }]);
  });
  test("metadata strips owner credentials and an exit audit is consumable only by its original account", () => {
    const store = storage();
    saveEmployeePreview(store, { ...preview, ownerAccessToken: "must-not-store" } as typeof preview);
    expect(readEmployeePreview(store)).toEqual(preview);
    expect(store.getItem(EMPLOYEE_PREVIEW_KEY)).not.toContain("must-not-store");
    queueEmployeeExit(store, preview);
    expect(takeEmployeeExit(store, employeeId)).toBeNull();
    expect(takeEmployeeExit(store, ownerId)).toEqual(preview);
    expect(takeEmployeeExit(store, ownerId)).toBeNull();
    expect(employeeAuthKey(preview)).not.toBe(employeeAuthKey({ ...preview, employeeId: teamId }));
    store.setItem(EMPLOYEE_PREVIEW_KEY, "not-json"); expect(readEmployeePreview(store)).toBeNull();
  });
});
