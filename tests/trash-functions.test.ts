import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Isolated request adapters: the real ownership helper and handlers still run.
const source = fileURLToPath(new URL("../src/lib/trash.functions.ts", import.meta.url));
const modules: Record<string, string> = {
  entry: `export * from ${JSON.stringify(source)}; export { requireSupabaseAuth } from "trash-test:auth";`,
  start: `export function createServerFn(options) {
    return {
      middleware(middlewares) { this.middlewares = middlewares; return this; },
      inputValidator(validate) { this.validate = validate; return this; },
      handler(handle) { return { ...options, middlewares: this.middlewares, validate: this.validate, handle }; }
    };
  }`,
  auth: `export const requireSupabaseAuth = { name: "requireSupabaseAuth" };`,
};
const built = await Bun.build({
  entrypoints: ["trash-test:entry"], target: "bun", write: false,
  plugins: [{
    name: "isolated-trash-handler-tests",
    setup(build) {
      build.onResolve({ filter: /^trash-test:/ }, ({ path }) => ({ path: path.slice(11), namespace: "trash-test" }));
      build.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({ path: "start", namespace: "trash-test" }));
      build.onResolve({ filter: /^@\/integrations\/supabase\/auth-middleware$/ }, () => ({ path: "auth", namespace: "trash-test" }));
      build.onLoad({ filter: /.*/, namespace: "trash-test" }, ({ path }) => ({ contents: modules[path]!, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
    },
  }],
});
if (!built.success) throw new AggregateError(built.logs, "Unable to load trash handlers");
const bundlePath = join(mkdtempSync(join(tmpdir(), "umbra-trash-test-")), "bundle.js");
writeFileSync(bundlePath, await built.outputs[0]!.text());
const api = await import(pathToFileURL(bundlePath).href);

const teamId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const employeeId = "44444444-4444-4444-8444-444444444444";

function fixture(options: { owner?: boolean; superadmin?: boolean; missing?: boolean; failure?: boolean } = {}) {
  const calls: string[] = [];
  const context = {
    userId: options.owner ? ownerId : employeeId,
    supabase: {
      from(table: string) {
        expect(table).toBe("teams");
        const query = {
          select() { return query; },
          eq(key: string, value: string) { expect([key, value]).toEqual(["id", teamId]); return query; },
          async maybeSingle() {
            return { data: options.missing ? null : { id: teamId, owner_id: ownerId }, error: options.failure ? { message: "offline" } : null };
          },
        };
        return query;
      },
      async rpc(name: string) {
        calls.push(name);
        return { data: name === "is_superadmin" ? !!options.superadmin : name === "list_trashed_profiles" ? [] : true, error: null };
      },
    },
  };
  return { calls, context };
}

async function invoke(name: string, f: ReturnType<typeof fixture>) {
  const endpoint = api[name];
  expect(endpoint.method).toBe("POST");
  expect(endpoint.middlewares).toEqual([api.requireSupabaseAuth]);
  const input = name === "listTrash" ? { teamId } : { teamId, profileId };
  const data = typeof endpoint.validate === "function" ? endpoint.validate(input) : endpoint.validate.parse(input);
  return endpoint.handle({ data, context: f.context });
}

describe("owner-only trash endpoints", () => {
  for (const endpoint of ["listTrash", "restoreProfile"]) {
    test(`${endpoint} rejects employees before invoking a trash RPC`, async () => {
      const f = fixture();
      await expect(invoke(endpoint, f)).rejects.toThrow("только для владельца");
      expect(f.calls).toEqual(["is_superadmin"]);
    });
    test(`${endpoint} accepts the real owner and global superadmin`, async () => {
      const rpc = endpoint === "listTrash" ? "list_trashed_profiles" : "restore_trashed_profile";
      const owner = fixture({ owner: true });
      await invoke(endpoint, owner);
      expect(owner.calls).toEqual([rpc]);
      const superadmin = fixture({ superadmin: true });
      await invoke(endpoint, superadmin);
      expect(superadmin.calls).toEqual(["is_superadmin", rpc]);
    });
    test(`${endpoint} fails closed for absent teams and ownership lookup errors`, async () => {
      for (const options of [{ missing: true }, { failure: true }]) {
        const f = fixture(options);
        await expect(invoke(endpoint, f)).rejects.toThrow();
        expect(f.calls).toEqual([]);
      }
    });
  }
});
