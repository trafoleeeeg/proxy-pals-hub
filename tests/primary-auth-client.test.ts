import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../src/lib/primary-auth-client.ts", import.meta.url));
const stub = `export const storage = { getItem() {}, setItem() {}, removeItem() {} };
  export const state = { calls: [] };
  export const brokeredPreviewStorage = () => storage;
  export function createClient(url, key, options) { state.calls.push({url,key,options}); return { auth: {} }; }`;
const built = await Bun.build({ entrypoints: ["primary-test:entry"], target: "bun", write: false,
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://auth.example.test", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture" }) },
  plugins: [{ name: "isolated-primary-client", setup(build) {
    build.onResolve({ filter: /^primary-test:/ }, ({ path }) => ({ path: path.slice(13), namespace: "primary-test" }));
    build.onResolve({ filter: /^@supabase\/supabase-js$|^@\/integrations\/supabase\/previewAuthStorage$/ }, () => ({ path: "stub", namespace: "primary-test" }));
    build.onLoad({ filter: /.*/, namespace: "primary-test" }, ({ path }) => ({
      contents: path === "stub" ? stub : `export * from ${JSON.stringify(source)}; export {state,storage} from 'primary-test:stub';`,
      loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    }));
  } }],
});
if (!built.success) throw new AggregateError(built.logs);
const path = join(mkdtempSync(join(tmpdir(), "umbra-primary-test-")), "fixture.js");
writeFileSync(path, await built.outputs[0]!.text());
const api = await import(pathToFileURL(path).href);

test("primary auth is lazy, singleton, and keeps the original storage and default session key", () => {
  expect(api.state.calls).toHaveLength(0);
  void api.primaryClient.auth; void api.primaryClient.auth;
  expect(api.state.calls).toHaveLength(1);
  expect(api.state.calls[0].options.auth).toMatchObject({ storage: api.storage, persistSession: true, autoRefreshToken: true });
  expect(api.state.calls[0].options.auth).not.toHaveProperty("storageKey");
});

test("bounded auth transport preserves user tokens and does not mistake the API key for a bearer token", async () => {
  const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  try {
    await api.sessionFetch("sb_publishable_fixture")("https://auth.example.test/auth/v1/user", { headers: { Authorization: "Bearer synthetic-user-token" } });
    const init = network.mock.calls[0]![1]!;
    expect((init.headers as Headers).get("apikey")).toBe("sb_publishable_fixture");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer synthetic-user-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await api.sessionFetch("sb_publishable_fixture")("https://auth.example.test/auth/v1/token", { headers: { Authorization: "Bearer sb_publishable_fixture" } });
    expect((network.mock.calls[1]![1]!.headers as Headers).has("Authorization")).toBe(false);
  } finally { network.mockRestore(); }
});
