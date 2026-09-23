import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bundle test doubles privately so other agents' tests keep their real modules.
const source = fileURLToPath(new URL("../src/lib/proxies.functions.ts", import.meta.url));
const modules: Record<string, string> = {
  entry: `export * from ${JSON.stringify(source)};
    export * from "proxy-test:crypto";
    export { requireSupabaseAuth } from "proxy-test:auth";`,
  start: `export function createServerFn(options) {
    return {
      middleware(middlewares) { this.middlewares = middlewares; return this; },
      inputValidator(validate) { this.validate = validate; return this; },
      handler(handle) { return { ...options, middlewares: this.middlewares, validate: this.validate, handle }; }
    };
  }`,
  auth: `export const requireSupabaseAuth = { name: "requireSupabaseAuth" };`,
  crypto: `import { mock } from "bun:test";
    export const encryptSecret = mock((plain) => "encrypted:" + plain);
    export const decryptSecret = mock(() => "p:@%");`,
};
const built = await Bun.build({
  entrypoints: ["proxy-test:entry"], target: "bun", write: false,
  plugins: [{
    name: "isolated-proxy-handler-tests",
    setup(build) {
      build.onResolve({ filter: /^proxy-test:/ }, ({ path }) => ({ path: path.slice(11), namespace: "proxy-test" }));
      build.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({ path: "start", namespace: "proxy-test" }));
      build.onResolve({ filter: /^@\/integrations\/supabase\/auth-middleware$/ }, () => ({ path: "auth", namespace: "proxy-test" }));
      build.onResolve({ filter: /^\.\/crypto\.server$/ }, () => ({ path: "crypto", namespace: "proxy-test" }));
      build.onLoad({ filter: /.*/, namespace: "proxy-test" }, ({ path }) => ({ contents: modules[path]!, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
    },
  }],
});
if (!built.success) throw new AggregateError(built.logs, "Unable to load proxy handlers");
const bundlePath = join(mkdtempSync(join(tmpdir(), "umbra-proxy-test-")), "bundle.js");
writeFileSync(bundlePath, await built.outputs[0]!.text());
const api = await import(pathToFileURL(bundlePath).href);

const teamId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const otherTeam = "44444444-4444-4444-8444-444444444444";
const otherUser = "55555555-5555-4555-8555-555555555555";
const target = { id, teamId };
const fields = { teamId, label: "Proxy", protocol: "http", host: "proxy.example", port: 8080, username: "u" };
const inUse = /\u041f\u0440\u043e\u043a\u0441\u0438 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442\u0441\u044f \u043f\u0440\u043e\u0444\u0438\u043b\u044f\u043c\u0438/;
type Row = Record<string, any>;
type Query = { table: string; action: string; columns: string; filters: [string, unknown][]; payload?: any; limit?: number };

function fixture() {
  const tables: Record<string, Row[]> = {
    teams: [{ id: teamId, owner_id: userId }, { id: otherTeam, owner_id: otherUser }],
    team_members: [{ team_id: teamId, user_id: userId, role: "owner" }],
    proxies: [{
      id, team_id: teamId, label: "Proxy", protocol: "http", host: "proxy.example", port: 8080,
      username: "u", password_enc: "existing-ciphertext", country: "DE", city: "Berlin",
      last_checked_at: "2026-09-14T00:00:00Z", last_check_ok: true, last_check_ip: "1.2.3.4",
      last_check_latency_ms: 15, last_check_error: null,
    }],
    browser_profiles: [], audit_log: [],
  };
  const calls: Query[] = [];
  const state = {
    tables, calls,
    error: undefined as { table: string; action: string; code: string } | undefined,
    missingMutation: false,
    context: { userId, supabase: { from } },
  };
  function from(table: string) {
    const query: Query = { table, action: "select", columns: "*", filters: [] };
    const chain = {
      select(columns = "*") { query.columns = columns; return chain; },
      eq(column: string, value: unknown) { query.filters.push([column, value]); return chain; },
      is(column: string, value: unknown) { query.filters.push([column, value]); return chain; },
      order() { return chain; },
      limit(limit: number) { query.limit = limit; return chain; },
      update(payload: Row) { query.action = "update"; query.payload = payload; return chain; },
      insert(payload: Row | Row[]) { query.action = "insert"; query.payload = payload; return chain; },
      delete() { query.action = "delete"; return chain; },
      maybeSingle: async () => execute(true),
      single: async () => execute(true),
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve().then(() => execute(false)).then(resolve, reject); },
    };
    function execute(single: boolean) {
      calls.push(structuredClone(query));
      if (state.error?.table === table && state.error.action === query.action) {
        return { data: null, error: { code: state.error.code, message: "private-database-details" } };
      }
      let selected = tables[table]!.filter((row) => query.filters.every(([column, value]) => row[column] === value));
      if (query.action !== "select" && state.missingMutation) selected = [];
      if (query.action === "update") selected.forEach((row) => Object.assign(row, query.payload));
      if (query.action === "delete") tables[table] = tables[table]!.filter((row) => !selected.includes(row));
      if (query.action === "insert") {
        selected = (Array.isArray(query.payload) ? query.payload : [query.payload]).map((row: Row) => ({ id, ...row }));
        tables[table]!.push(...selected);
      }
      if (query.limit !== undefined) selected = selected.slice(0, query.limit);
      const rows = selected.map((row) => query.columns === "*" ? { ...row }
        : Object.fromEntries(query.columns.split(",").map((column) => [column.trim(), row[column.trim()]])));
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
    return chain;
  }
  return state;
}

type Fixture = ReturnType<typeof fixture>;
async function invoke(name: string, data: unknown, f: Fixture) {
  const endpoint = api[name];
  expect(endpoint.method).toBe("POST");
  expect(endpoint.middlewares).toEqual([api.requireSupabaseAuth]);
  return endpoint.handle({ data: endpoint.validate(data), context: f.context });
}
const mutations = (f: Fixture) => f.calls.filter((call) => call.action !== "select");
const ownerActions: [string, Row][] = [
  ["rotateProxyIp", target],
  ["saveProxy", fields], ["saveProxy", { ...fields, id }], ["deleteProxy", target],
  ["importProxies", { teamId, text: "proxy.example:80" }], ["proxyForCheck", target],
  ["recordProxyCheck", { ...target, ok: true, ip: "1.2.3.4" }], ["checkProxy", target],
];

beforeEach(() => {
  api.encryptSecret.mockClear();
  api.decryptSecret.mockReset();
  api.decryptSecret.mockImplementation(() => "p:@%");
});

describe("proxy authorization and team boundaries", () => {
  test.each(ownerActions)("%s denies a non-owner even with a forged membership role", async (name, data) => {
    const f = fixture();
    f.tables.teams[0]!.owner_id = otherUser;
    await expect(invoke(name, data, f)).rejects.toThrow();
    expect(mutations(f)).toHaveLength(0);
    expect(f.calls.some((call) => call.table === "proxies")).toBe(false);
    expect(api.encryptSecret).not.toHaveBeenCalled();
    expect(api.decryptSecret).not.toHaveBeenCalled();
  });

  test.each(["checkProxy", "deleteProxy", "proxyForCheck", "recordProxyCheck", "saveProxy", "rotateProxyIp"])("%s cannot access a proxy from another team", async (name) => {
    const f = fixture(); f.tables.proxies[0]!.team_id = otherTeam;
    await expect(invoke(name, { ...fields, ...target, ok: true, ip: "1.2.3.4" }, f)).rejects.toThrow();
    expect(mutations(f)).toHaveLength(0);
    expect(api.decryptSecret).not.toHaveBeenCalled();
  });

  test("team ownership works without a membership row; ordinary members can only list", async () => {
    const owner = fixture(); owner.tables.team_members = [];
    expect((await invoke("checkProxy", target, owner)).status).toBe("desktop_required");
    const member = fixture(); member.tables.teams[0]!.owner_id = otherUser;
    member.tables.team_members[0]!.role = "member";
    expect(await invoke("listProxies", { teamId }, member)).toHaveLength(1);
    const membership = member.calls.find((call) => call.table === "team_members")!;
    expect(membership.filters).toContainEqual(["team_id", teamId]);
    expect(membership.filters).toContainEqual(["user_id", userId]);
    member.tables.team_members = [];
    await expect(invoke("listProxies", { teamId }, member)).rejects.toThrow();
  });

  test("invalid team/target values are rejected before database access", async () => {
    for (const [name, data] of ownerActions) {
      const f = fixture();
      await expect(invoke(name, { ...data, teamId: "invalid" }, f)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });

  test("guard query failures deny access without echoing database details", async () => {
    const f = fixture(); f.error = { table: "teams", action: "select", code: "42501" };
    await invoke("checkProxy", target, f).then(() => { throw new Error("Expected denial"); }, (error) => {
      expect(error.message).not.toContain("private");
    });
    expect(mutations(f)).toHaveLength(0);
  });
});

describe("proxy persistence and secret boundaries", () => {
  test("lists only safe fields and sanitizes legacy transport errors", async () => {
    const f = fixture(); f.tables.proxies[0]!.last_check_error = "http://u:private@host:80";
    const rows = await invoke("listProxies", { teamId }, f);
    expect(rows[0].hasPassword).toBe(true);
    expect(rows[0]).not.toHaveProperty("password_enc");
    expect(JSON.stringify(rows)).not.toContain("private");
    expect(JSON.stringify(rows)).not.toContain("existing-ciphertext");
    expect(f.calls.find((call) => call.table === "proxies")!.filters).toContainEqual(["team_id", teamId]);
    expect(api.decryptSecret).not.toHaveBeenCalled();
  });

  test.each([undefined, "preserve", "clear", "replace"])("save password action %s changes only the intended secret", async (action) => {
    const f = fixture();
    await invoke("saveProxy", { ...fields, id, passwordAction: action, ...(action === "replace" ? { password: "new:@%" } : {}) }, f);
    const update = mutations(f)[0]!;
    expect(update.filters).toContainEqual(["id", id]);
    expect(update.filters).toContainEqual(["team_id", teamId]);
    expect(update.payload).not.toHaveProperty("password");
    expect(api.decryptSecret).not.toHaveBeenCalled();
    if (action === "replace") {
      expect(api.encryptSecret).toHaveBeenCalledWith("new:@%");
      expect(f.tables.proxies[0]!.password_enc).toBe("encrypted:new:@%");
    } else if (action === "clear") {
      expect(f.tables.proxies[0]!.password_enc).toBeNull();
      expect(api.encryptSecret).not.toHaveBeenCalled();
    } else {
      expect(update.payload).not.toHaveProperty("password_enc");
      expect(f.tables.proxies[0]!.password_enc).toBe("existing-ciphertext");
      expect(api.encryptSecret).not.toHaveBeenCalled();
    }
    expect(f.tables.proxies[0]!.last_check_ok).toBeNull();
  });

  test("connection update blocked by an active profile returns a friendly error", async () => {
    const f = fixture(); const previous = structuredClone(f.tables.proxies);
    f.error = { table: "proxies", action: "update", code: "55P03" };
    await expect(invoke("saveProxy", { ...fields, id, host: "changed.example" }, f)).rejects.toThrow(
      "\u0417\u0430\u043a\u0440\u043e\u0439\u0442\u0435 \u043f\u0440\u043e\u0444\u0438\u043b\u0438, " +
      "\u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u044e\u0449\u0438\u0435 \u044d\u0442\u043e\u0442 \u043f\u0440\u043e\u043a\u0441\u0438, " +
      "\u043f\u0435\u0440\u0435\u0434 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0435\u043c \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f",
    );
    expect(f.tables.proxies).toEqual(previous);
    expect(mutations(f)).toHaveLength(1);
    expect(f.calls.some((call) => call.table === "audit_log")).toBe(false);
  });

  test("label edits and recorded checks preserve connection settings", async () => {
    const f = fixture();
    const connection = { protocol: "http", host: "proxy.example", port: 8080, username: "u", password_enc: "existing-ciphertext" };
    expect(await invoke("saveProxy", { ...fields, id, label: "Renamed", passwordAction: "preserve" }, f)).toEqual({ id });
    expect(f.tables.proxies[0]).toMatchObject({ ...connection, label: "Renamed" });
    expect(mutations(f)[0]!.payload).not.toHaveProperty("password_enc");
    expect(await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.4" }, f)).toEqual({ ok: true });
    expect(f.tables.proxies[0]).toMatchObject({ ...connection, label: "Renamed", last_check_ok: true, last_check_ip: "1.2.3.4" });
    for (const key of Object.keys(connection)) expect(mutations(f)[1]!.payload).not.toHaveProperty(key);
  });

  test("creation synchronizes only an encrypted proxy password with authenticated ownership", async () => {
    const f = fixture();
    expect(await invoke("saveProxy", { ...fields, password: "p:@%", created_by: otherUser, team_id: otherTeam }, f)).toEqual({ id });
    const inserted = mutations(f)[0]!.payload;
    expect(inserted.team_id).toBe(teamId);
    expect(inserted.created_by).toBe(userId);
    expect(inserted.password_enc).toBe("encrypted:p:@%");
    expect(inserted).not.toHaveProperty("password");
    expect(mutations(f)[1]!.payload).toEqual({
      team_id: teamId, user_id: userId, action: "proxy.created", target_type: "proxy", target_id: id,
    });
  });

  test("audit failure reports partial success without exposing database details", async () => {
    const f = fixture(); f.tables.proxies = [];
    f.error = { table: "audit_log", action: "insert", code: "42501" };
    await invoke("saveProxy", { ...fields, password: "private-password" }, f).then(
      () => { throw new Error("Expected audit failure"); },
      (error) => {
        expect(error.message).toMatch(/\u041f\u0440\u043e\u043a\u0441\u0438 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d/);
        expect(error.message).toMatch(/\u0436\u0443\u0440\u043d\u0430\u043b/);
        expect(error.message).not.toContain("private");
      },
    );
    expect(f.tables.proxies).toHaveLength(1);
    expect(f.tables.audit_log).toHaveLength(0);
    expect(mutations(f).map(({ table, action }) => [table, action]))
      .toEqual([["proxies", "insert"], ["audit_log", "insert"]]);
  });

  test("failed proxy creation does not record a creation event", async () => {
    const f = fixture(); f.error = { table: "proxies", action: "insert", code: "42501" };
    await expect(invoke("saveProxy", fields, f)).rejects.toThrow();
    expect(f.calls.some((call) => call.table === "audit_log")).toBe(false);
  });

  test("removing a login with a preserved password requires an explicit clear", async () => {
    const f = fixture();
    await expect(invoke("saveProxy", { ...fields, id, username: "", passwordAction: "preserve" }, f)).rejects.toThrow();
    expect(mutations(f)).toHaveLength(0);
    expect(api.decryptSecret).not.toHaveBeenCalled();
    await invoke("saveProxy", { ...fields, id, username: "", passwordAction: "clear" }, f);
    expect(f.tables.proxies[0]).toMatchObject({ username: null, password_enc: null });
    await invoke("saveProxy", { ...fields, id, username: "", passwordAction: "preserve" }, f);
    expect(f.tables.proxies[0]).toMatchObject({ username: null, password_enc: null });
  });

  test("import rejects a mixed invalid list without partial inserts", async () => {
    const f = fixture();
    const result = await invoke("importProxies", { teamId, text: "proxy.example:80\nbad-private-password" }, f);
    expect(result.added).toBe(0);
    expect(result.issues[0].line).toBe(2);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(mutations(f)).toHaveLength(0);
    expect(api.encryptSecret).not.toHaveBeenCalled();
  });

  test("import preserves literal passwords and writes one bounded batch", async () => {
    const f = fixture();
    const result = await invoke("importProxies", { teamId, protocol: "socks5", text: "[::1]:1080:u:p:@%\nhttp://proxy.example:80" }, f);
    expect(result).toEqual({ added: 2, issues: [] });
    expect(mutations(f)).toHaveLength(1);
    const rows = mutations(f)[0]!.payload;
    expect(rows[0]).toMatchObject({ protocol: "socks5", password_enc: "encrypted:p:@%", created_by: userId, team_id: teamId });
    expect(rows[1]).toMatchObject({ protocol: "http", password_enc: null });
    for (const row of rows) expect(row).not.toHaveProperty("password");
  });

  test("desktop credentials are loaded only after owner and team checks", async () => {
    const f = fixture();
    expect(await invoke("proxyForCheck", target, f)).toEqual({ id, protocol: "http", host: "proxy.example", port: 8080, username: "u", password: "p:@%" });
    expect(api.decryptSecret).toHaveBeenCalledWith("existing-ciphertext");
    api.decryptSecret.mockImplementation(() => { throw new Error("private-encryption-details"); });
    await invoke("proxyForCheck", target, f).then(() => { throw new Error("Expected failure"); }, (error) => {
      expect(error.message).not.toContain("private");
      expect(error.message).toMatch(/\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u0435/);
    });
  });
});

describe("proxy check persistence and deletion", () => {
  test("web check returns desktop_required without decrypt, network or last-check writes", async () => {
    const f = fixture(); const previous = structuredClone(f.tables.proxies);
    const network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected proxy network access"); });
    try {
      expect(await invoke("checkProxy", target, f)).toMatchObject({ status: "desktop_required", supported: false, ok: null });
      expect(api.decryptSecret).not.toHaveBeenCalled();
      expect(api.encryptSecret).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(mutations(f)).toHaveLength(0);
      expect(f.tables.proxies).toEqual(previous);
      expect(f.calls.find((call) => call.table === "proxies")!.columns).toBe("id");
    } finally { network.mockRestore(); }
  });

  test.each([{}, { country: undefined, city: undefined }, { country: "", city: "" }])("success preserves omitted locale %j", async (locale) => {
    const f = fixture();
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "2001:db8::1", latency: 0, ...locale }, f);
    const update = mutations(f)[0]!;
    expect(update.payload).not.toHaveProperty("country");
    expect(update.payload).not.toHaveProperty("city");
    expect(f.tables.proxies[0]).toMatchObject({ country: "DE", city: "Berlin", last_check_ok: true, last_check_ip: "2001:db8::1", last_check_latency_ms: 0, last_check_error: null });
    expect(update.filters).toContainEqual(["team_id", teamId]);
    expect(update.filters).toContainEqual(["id", id]);
  });

  test("success updates supplied locale and failure cannot overwrite locale or expose raw errors", async () => {
    const f = fixture();
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.4", country: "fr", city: "Paris" }, f);
    expect(f.tables.proxies[0]).toMatchObject({ country: "FR", city: "Paris" });
    await invoke("recordProxyCheck", { ...target, ok: false, country: "US", city: "Stale", error: "http://u:private@host:80" }, f);
    expect(f.tables.proxies[0]).toMatchObject({ country: "FR", city: "Paris", last_check_ok: false, last_check_ip: null });
    expect(JSON.stringify(mutations(f))).not.toContain("private");
  });

  test("invalid check results never reach the database", async () => {
    const f = fixture();
    for (const result of [{ ok: true }, { ok: null, status: "desktop_required" }, { ok: true, ip: "not-ip" }]) {
      await expect(invoke("recordProxyCheck", { ...target, ...result }, f)).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });

  test.each(["saveProxy", "recordProxyCheck", "deleteProxy"])("%s rejects zero affected rows", async (name) => {
    const f = fixture(); f.missingMutation = true;
    await expect(invoke(name, { ...fields, ...target, ok: true, ip: "1.2.3.4" }, f)).rejects.toThrow();
  });

  test("assigned proxy returns a friendly error before deletion", async () => {
    const f = fixture(); f.tables.browser_profiles.push({ id: "profile", proxy_id: id, team_id: teamId });
    await expect(invoke("deleteProxy", target, f)).rejects.toThrow(inUse);
    expect(mutations(f)).toHaveLength(0);
    expect(f.tables.proxies).toHaveLength(1);
  });

  test("concurrent assignment blocked by FK produces the same friendly error", async () => {
    const f = fixture(); f.error = { table: "proxies", action: "delete", code: "23503" };
    await expect(invoke("deleteProxy", target, f)).rejects.toThrow(inUse);
    expect(f.tables.proxies).toHaveLength(1);
  });

  test("a failed assignment lookup prevents deletion; an unused proxy can be deleted", async () => {
    const f = fixture(); f.error = { table: "browser_profiles", action: "select", code: "42501" };
    await expect(invoke("deleteProxy", target, f)).rejects.toThrow();
    expect(mutations(f)).toHaveLength(0);
    f.error = undefined;
    expect(await invoke("deleteProxy", target, f)).toEqual({ ok: true });
    expect(f.tables.proxies).toHaveLength(0);
  });
});

describe("mobile proxy rotation", () => {
  const ready = () => {
    const f = fixture();
    Object.assign(f.tables.proxies[0]!, { rotation_url_enc: "encrypted-rotation", rotation_status: "ready", rotation_requested_at: null, last_checked_at: new Date().toISOString() });
    api.decryptSecret.mockImplementation(() => "https://provider.example/rotate?token=private-token");
    return f;
  };
  test("one concurrent request wins; duplicate requests cannot invoke the provider", async () => {
    const f = ready();
    const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const results = await Promise.allSettled([invoke("rotateProxyIp", target, f), invoke("rotateProxyIp", target, f)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(network).toHaveBeenCalledTimes(1);
      expect(f.tables.proxies[0]).toMatchObject({ rotation_status: "changing", rotation_previous_ip: "1.2.3.4" });
      expect(JSON.stringify(results)).not.toContain("private-token");
      expect(network.mock.calls[0]![1]).toMatchObject({ redirect: "follow" });
    } finally { network.mockRestore(); }
  });
  test("failed or zero-row claims never call the provider", async () => {
    for (const missing of [false, true]) {
      const f = ready();
      if (missing) f.missingMutation = true;
      else f.error = { table: "proxies", action: "update", code: "500" };
      const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
      try {
        await expect(invoke("rotateProxyIp", target, f)).rejects.toThrow();
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }
    }
  });
  test("only a matching rotation check with a changed IP records a confirmed transition", async () => {
    const f = ready();
    const requestedAt = new Date().toISOString();
    Object.assign(f.tables.proxies[0]!, { rotation_status: "changing", rotation_requested_at: requestedAt, rotation_previous_ip: "1.2.3.4" });
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.4", rotationRequestedAt: requestedAt }, f);
    expect(f.tables.proxies[0]!.rotation_status).toBe("changing");
    await invoke("recordProxyCheck", { ...target, ok: false, rotationRequestedAt: requestedAt }, f);
    expect(f.tables.proxies[0]!.rotation_previous_ip).toBe("1.2.3.4");
    await expect(invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.9", rotationRequestedAt: "2000-01-01T00:00:00Z" }, f)).resolves.toMatchObject({ ok: true, staleRotation: true });
    expect(f.tables.proxies[0]).toMatchObject({ rotation_status: "changing", last_check_ip: "1.2.3.9" });
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.5", rotationRequestedAt: requestedAt, rotationConfirmed: false }, f);
    expect(f.tables.proxies[0]!.rotation_status).toBe("changing");
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.5", rotationRequestedAt: requestedAt, rotationFinal: true, rotationConfirmed: true }, f);
    expect(f.tables.proxies[0]).toMatchObject({ rotation_status: "success", rotation_previous_ip: "1.2.3.4", rotation_new_ip: "1.2.3.5" });
    await expect(invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.5", rotationRequestedAt: requestedAt }, f)).resolves.toEqual({ ok: true });
    const changedAt = f.tables.proxies[0]!.rotation_changed_at;
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.6" }, f);
    expect(f.tables.proxies[0]).toMatchObject({ rotation_new_ip: "1.2.3.5", rotation_changed_at: changedAt });
  });
  test("a later successful check reconciles a timed-out rotation", async () => {
    const f = ready();
    const requestedAt = new Date(Date.now() - 120_000).toISOString();
    Object.assign(f.tables.proxies[0]!, {
      rotation_status: "error", rotation_requested_at: requestedAt,
      rotation_previous_ip: "1.2.3.4", rotation_last_error: "not_confirmed",
    });
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.9" }, f);
    expect(f.tables.proxies[0]).toMatchObject({
      rotation_status: "success", rotation_previous_ip: "1.2.3.4",
      rotation_new_ip: "1.2.3.9", rotation_last_error: null,
    });
  });
  test("a later check with the old IP does not hide a failed rotation", async () => {
    const f = ready();
    Object.assign(f.tables.proxies[0]!, {
      rotation_status: "error", rotation_requested_at: new Date(Date.now() - 120_000).toISOString(),
      rotation_previous_ip: "1.2.3.4", rotation_last_error: "not_confirmed",
    });
    await invoke("recordProxyCheck", { ...target, ok: true, ip: "1.2.3.4" }, f);
    expect(f.tables.proxies[0]!.rotation_status).toBe("error");
  });
});
