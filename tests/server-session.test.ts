import { describe, expect, test } from "bun:test";
import { classifyTerminalClose, prepareSessionLaunch } from "../src/lib/server-session";
import { generateFingerprint } from "../src/lib/fingerprint";
import type { ServerContext } from "../src/lib/server-db";

const id = "30000000-0000-4000-8000-000000000001";
const teamId = "20000000-0000-4000-8000-000000000001";
const token = "50000000-0000-4000-8000-000000000001";
function fixture() {
  const state = {
    profile: { id, team_id: teamId, name: "Synthetic profile", fingerprint: generateFingerprint("US"), cookies_enc: "encrypted-cookies", cookies_updated_at: "2026-09-15T00:00:00Z", proxy_id: "40000000-0000-4000-8000-000000000001" as string | null },
    proxy: { protocol: "socks5", host: "proxy.example.test", port: 1080, username: "synthetic", password_enc: "encrypted-password" } as Record<string, unknown> | null,
    rpc: [] as { name: string; args: Record<string, unknown> }[],
    filters: [] as [string, string, unknown][],
    failRelease: false, failAudit: false,
  };
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpc.push({ name, args });
      if (name === "acquire_profile_lease") return { data: { lockToken: token, expiresAt: "2026-09-15T00:05:00Z" }, error: null };
      return state.failRelease ? { data: null, error: { message: "lease-write-failed" } } : { data: {}, error: null };
    },
    from(table: string) {
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { state.filters.push([table, key, value]); return query; },
        single: async () => ({ data: state.profile, error: null }),
        maybeSingle: async () => ({ data: state.proxy, error: null }),
        insert: async () => ({ error: state.failAudit ? { message: "audit-write-failed" } : null }),
      };
      return query;
    },
  };
  const context = { supabase: client, userId: "10000000-0000-4000-8000-000000000001" } as unknown as ServerContext;
  const decrypt = (value: string | null | undefined) => value === "encrypted-cookies" ? "[]" : "synthetic-password";
  return { state, context, decrypt };
}

describe("server launch transaction boundary", () => {
  test("launch restores cloud cookies and the encrypted same-team proxy password on another device", async () => {
    const f = fixture();
    const result = await prepareSessionLaunch(f.context, { profileId: id, deviceId: "desktop-a" }, f.decrypt);
    expect(result).toMatchObject({ profileId: id, lockToken: token, deviceId: "desktop-a", cookies: "[]", proxy: { protocol: "socks5", password: "synthetic-password" } });
    expect(f.state.filters).toContainEqual(["proxies", "team_id", teamId]);
    expect(f.state.rpc).toHaveLength(1);
  });
  test("missing assigned proxy cancels launch and releases only the acquired token", async () => {
    const f = fixture(); f.state.proxy = null;
    await expect(prepareSessionLaunch(f.context, { profileId: id, deviceId: "desktop-a" }, f.decrypt)).rejects.toThrow("Запуск отменён");
    expect(f.state.rpc[1]).toMatchObject({ name: "mutate_profile_lease", args: { _profile_id: id, _lock_token: token, _operation: "close", _cookies_enc: null, _device_id: "desktop-a" } });
  });
  test("direct browsing is possible only when no proxy is assigned", async () => {
    const f = fixture(); f.state.profile.proxy_id = null;
    expect((await prepareSessionLaunch(f.context, { profileId: id }, f.decrypt)).proxy).toBeNull();
    expect(f.state.filters.some(([table]) => table === "proxies")).toBe(false);
  });
  test("cookie decryption and audit failures do not leave a silently running lease", async () => {
    const f = fixture();
    await expect(prepareSessionLaunch(f.context, { profileId: id }, () => { throw new Error("Wrong key"); })).rejects.toThrow("Wrong key");
    expect(f.state.rpc.at(-1)?.args._operation).toBe("close");
    const audit = fixture(); audit.state.failAudit = true;
    await expect(prepareSessionLaunch(audit.context, { profileId: id }, audit.decrypt)).rejects.toThrow("audit-write-failed");
    expect(audit.state.rpc.at(-1)?.args._operation).toBe("close");
  });
  test("a failed cleanup is reported instead of pretending the profile was unlocked", async () => {
    const f = fixture(); f.state.proxy = null; f.state.failRelease = true;
    await expect(prepareSessionLaunch(f.context, { profileId: id }, f.decrypt)).rejects.toThrow("не удалось снять блокировку");
  });
});

test("only confirmed lease denial ends close retries", () => {
  expect(classifyTerminalClose(new Error("No profile access"))).toBe("access_revoked");
  expect(classifyTerminalClose(new Error("Session lease lost; reopen the profile"))).toBe("lease_lost");
  expect(classifyTerminalClose(new Error("temporary database outage"))).toBeNull();
});
