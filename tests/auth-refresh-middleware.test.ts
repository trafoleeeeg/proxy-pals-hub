import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../src/lib/auth-function-middleware.ts", import.meta.url));
const modules: Record<string, string> = {
  entry: `export * from ${JSON.stringify(source)}; export * from 'auth-test:session';`,
  start: `export const createMiddleware = () => ({ client: handle => handle });`,
  session: `export const state = { expired: 0, refreshes: 0, failRefresh: false };
    export const getUsableSession = async () => ({ access_token: 'old-synthetic-token' });
    export const forceRefreshSession = async () => { state.refreshes++; if (state.failRefresh) throw new Error('offline'); return { access_token: 'new-synthetic-token' }; };
    export const expireLocalSession = async () => { state.expired++; };`,
};
const built = await Bun.build({ entrypoints: ["auth-test:entry"], target: "bun", write: false,
  plugins: [{ name: "isolated-refresh-middleware", setup(build) {
    build.onResolve({ filter: /^auth-test:/ }, ({ path }) => ({ path: path.slice(10), namespace: "auth-test" }));
    build.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({ path: "start", namespace: "auth-test" }));
    build.onResolve({ filter: /^\.\/auth-session$/ }, () => ({ path: "session", namespace: "auth-test" }));
    build.onLoad({ filter: /.*/, namespace: "auth-test" }, ({ path }) => ({ contents: modules[path]!, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
  } }],
});
if (!built.success) throw new AggregateError(built.logs);
const path = join(mkdtempSync(join(tmpdir(), "umbra-refresh-test-")), "fixture.js");
writeFileSync(path, await built.outputs[0]!.text());
const api = await import(pathToFileURL(path).href);
afterEach(() => { api.state.expired = 0; api.state.refreshes = 0; api.state.failRefresh = false; });

test("a temporary refresh failure after HTTP 401 must not sign out the user", async () => {
  api.state.failRefresh = true;
  const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  try {
    await expect(api.attachFreshSupabaseAuth({ next: ({ fetch }: { fetch: typeof globalThis.fetch }) => fetch("https://panel.example.test/action") })).rejects.toThrow("offline");
    expect(api.state.expired).toBe(0);
    expect(api.state.refreshes).toBe(1);
    expect(network).toHaveBeenCalledTimes(1);
  } finally { network.mockRestore(); }
});

test.each([200, 401])("replays only a rejected token and expires only a second 401 (retry HTTP %s)", async (status) => {
  const network = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response(null, { status }));
  try {
    const result = await api.attachFreshSupabaseAuth({ next: ({ fetch }: { fetch: typeof globalThis.fetch }) => fetch("https://panel.example.test/action", { method: "POST", body: "synthetic" }) });
    expect(result.status).toBe(status);
    expect(api.state.expired).toBe(status === 401 ? 1 : 0);
    expect(network).toHaveBeenCalledTimes(2);
    expect((network.mock.calls[1]![0] as Request).headers.get("Authorization")).toBe("Bearer new-synthetic-token");
    expect(await (network.mock.calls[1]![0] as Request).text()).toBe("synthetic");
  } finally { network.mockRestore(); }
});

test("server errors are not automatically replayed or treated as logout", async () => {
  const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  try {
    await expect(api.attachFreshSupabaseAuth({ next: ({ fetch }: { fetch: typeof globalThis.fetch }) => fetch("https://panel.example.test/action") })).rejects.toThrow("Нет связи с сервером");
    expect(network).toHaveBeenCalledTimes(1);
    expect(api.state.expired).toBe(0);
    expect(api.state.refreshes).toBe(0);
  } finally { network.mockRestore(); }
});
