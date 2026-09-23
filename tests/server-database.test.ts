import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let db: PGlite;
const owner = "10000000-0000-4000-8000-000000000001";
const member = "10000000-0000-4000-8000-000000000002";
const outsider = "10000000-0000-4000-8000-000000000003";
const team = "20000000-0000-4000-8000-000000000001";
const otherTeam = "20000000-0000-4000-8000-000000000002";
const profile = "30000000-0000-4000-8000-000000000001";
const otherProfile = "30000000-0000-4000-8000-000000000002";
const proxy = "40000000-0000-4000-8000-000000000001";

async function asUser<T>(user: string, sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    await tx.exec("set local role authenticated");
    return (await tx.query<T>(sql, params)).rows;
  });
}
async function acquire(user = owner, device = "desktop-a") {
  const rows = await asUser<{ lease: { lockToken: string; cookiesUpdatedAt: string } }>(user,
    "select public.acquire_profile_lease($1, $2, 'Windows') as lease", [profile, device]);
  return rows[0]!.lease;
}
async function mutate(token: string, operation: string, cookies: string | null = null, user = owner, device: string | null = null) {
  return asUser<{ result: { cookiesUpdatedAt: string } }>(user, "select public.mutate_profile_lease($1, $2, $3, $4, $5) as result", [profile, token, operation, cookies, device]);
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create role authenticated; create role anon; create role service_role bypassrls;
    create publication supabase_realtime;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to authenticated, anon, service_role;
    grant execute on function auth.uid() to authenticated, anon, service_role;
  `);
  const dir = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
  for (const file of (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort()) {
    // PGlite does not bundle pg_cron; the retention functions and RLS are
    // tested here, while this extension-backed schedule is deployed on Supabase.
    if (file === "20260924100000_enable_retention_cron.sql") continue;
    if (file.startsWith("20260919215434_")) {
      // Одноразовая миграция объединения команд привязана к реальным идентификаторам —
      // создаём целевую команду и суперадмина, как в рабочей базе.
      await db.query("insert into auth.users(id, email, email_confirmed_at) values ($1, $2, now())", ["8f9bf3e6-def2-47ac-938a-d37c7f6b33ff", "mafiatrafa@umbra.app"]);
      await db.query("insert into public.teams(id, owner_id) values ($1, $2)", ["edab663b-a15f-4f9c-a914-fca4bce85d7e", "8f9bf3e6-def2-47ac-938a-d37c7f6b33ff"]);
    }
    await db.exec(await readFile(`${dir}/${file}`, "utf8"));
  }
  for (const [id, email] of [[owner, "owner@example.test"], [member, "member@example.test"], [outsider, "outsider@example.test"]]) {
    await db.query("insert into auth.users(id, email, email_confirmed_at) values ($1, $2, now())", [id, email]);
  }
  await db.query("insert into public.teams(id, owner_id) values ($1, $2), ($3, $4)", [team, owner, otherTeam, outsider]);
  await db.query("insert into public.team_members(team_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')", [team, owner, member, otherTeam, outsider]);
  await db.query("insert into public.proxies(id, team_id, host, port) values ($1, $2, '127.0.0.1', 8080)", [proxy, team]);
  await db.query("insert into public.browser_profiles(id, team_id, name, proxy_id) values ($1, $2, 'A', $3), ($4, $5, 'B', null)", [profile, team, proxy, otherProfile, otherTeam]);
}, 30000);
afterAll(async () => { await db?.close(); });

describe("real migrations and RLS", () => {
  test("unfiled profiles follow default-folder access without changing their folder", async () => {
    const legacyMember = crypto.randomUUID();
    const legacyProfile = crypto.randomUUID();
    await db.query("insert into auth.users(id, email, email_confirmed_at) values ($1, 'legacy@example.test', now())", [legacyMember]);
    await db.query("insert into public.team_members(team_id, user_id, role) values ($1, $2, 'member')", [team, legacyMember]);
    await db.query("insert into public.browser_profiles(id, team_id, name, folder) values ($1, $2, 'Unfiled', '')", [legacyProfile, team]);
    try {
      expect(await asUser(legacyMember, "select id from public.browser_profiles where id = $1", [legacyProfile])).toEqual([]);
      await asUser(owner, "select public.set_folder_access($1, 'Основная', $2, true)", [team, legacyMember]);
      expect(await asUser(legacyMember, "select id from public.browser_profiles where id = $1", [legacyProfile])).toEqual([{ id: legacyProfile }]);
      expect((await db.query<{ allowed: boolean }>("select private.can_access_profile($1, $2) as allowed", [legacyMember, legacyProfile])).rows).toEqual([{ allowed: true }]);
      await asUser(owner, "select public.set_member_permissions($1, $2, false, true, false, false, false, false, false)", [team, legacyMember]);
      expect(await asUser(legacyMember, "update public.browser_profiles set name = 'Updated' where id = $1 returning name", [legacyProfile])).toEqual([{ name: "Updated" }]);
      expect((await db.query<{ folder: string }>("select folder from public.browser_profiles where id = $1", [legacyProfile])).rows[0]!.folder).toBe("");
      await asUser(owner, "select public.set_folder_access($1, 'Основная', $2, false)", [team, legacyMember]);
      expect(await asUser(legacyMember, "select id from public.browser_profiles where id = $1", [legacyProfile])).toEqual([]);
    } finally {
      await db.query("delete from public.browser_profiles where id = $1", [legacyProfile]);
      await db.query("delete from public.team_members where team_id = $1 and user_id = $2", [team, legacyMember]);
      await db.query("delete from auth.users where id = $1", [legacyMember]);
    }
  });

  test("folder order is saved atomically and cannot include another team's folder", async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await db.query("insert into public.profile_folders(id, team_id, name) values ($1, $2, 'First'), ($3, $2, 'Second'), ($4, $5, 'Foreign')", [first, team, second, foreign, otherTeam]);
    await expect(asUser(owner, "select public.reorder_team_folders($1, $2::uuid[])", [team, [first, foreign]])).rejects.toThrow("Некорректный порядок");
    await asUser(owner, "select public.reorder_team_folders($1, $2::uuid[])", [team, [second, first]]);
    const order = await asUser<{ id: string }>(owner, "select id from public.profile_folders where team_id = $1 and id = any($2::uuid[]) order by position", [team, [first, second]]);
    expect(order.map((row) => row.id)).toEqual([second, first]);
    await expect(asUser(outsider, "select public.reorder_team_folders($1, $2::uuid[])", [team, [first, second]])).rejects.toThrow("Недостаточно прав");
  });

  test("trash hides profiles, preserves cookies, restores them, and purges after 14 days", async () => {
    const id = crypto.randomUUID();
    await db.query("insert into public.browser_profiles(id, team_id, name, cookies_enc) values ($1, $2, 'Trash test', 'encrypted')", [id, team]);
    await asUser(owner, "select public.bulk_mutate_profiles($1, $2::uuid[], 'delete', '{}'::jsonb)", [team, [id]]);
    expect(await asUser(owner, "select id from public.browser_profiles where id = $1", [id])).toEqual([]);
    await expect(asUser(owner, "select public.acquire_profile_lease($1, 'desktop')", [id])).rejects.toThrow("No profile access");
    expect(await asUser<{ id: string }>(owner, "select id from public.list_trashed_profiles($1)", [team])).toContainEqual({ id });
    await expect(asUser(outsider, "select id from public.list_trashed_profiles($1)", [team])).rejects.toThrow("Нет доступа");
    await asUser(owner, "select public.restore_trashed_profile($1, $2)", [team, id]);
    expect(await asUser(owner, "select cookies_enc from public.browser_profiles where id = $1", [id])).toEqual([{ cookies_enc: "encrypted" }]);
    await asUser(owner, "select public.bulk_mutate_profiles($1, $2::uuid[], 'delete', '{}'::jsonb)", [team, [id]]);
    await db.query("update public.browser_profiles set deleted_at = now() - interval '15 days' where id = $1", [id]);
    await asUser(owner, "select id from public.list_trashed_profiles($1)", [team]);
    expect((await db.query("select id from public.browser_profiles where id = $1", [id])).rows).toEqual([]);
  });

  test("agent trash helper is service-only and cannot bypass active locks", async () => {
    const id = crypto.randomUUID();
    await db.query("insert into public.browser_profiles(id, team_id, name) values ($1, $2, 'Agent trash')", [id, team]);
    await expect(asUser(owner, "select public.trash_agent_profile($1, $2)", [team, id])).rejects.toThrow("permission denied");
    const serviceCall = () => db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      return (await tx.query("select public.trash_agent_profile($1, $2)", [team, id])).rows;
    });
    await serviceCall();
    expect((await db.query<{ deleted_at: string | null }>("select deleted_at from public.browser_profiles where id = $1", [id])).rows[0]!.deleted_at).not.toBeNull();
  });

  test("team audit expires after two months and members cannot prune it", async () => {
    const id = crypto.randomUUID();
    await db.query("insert into public.audit_log(id, team_id, user_id, action, created_at) values ($1, $2, $3, 'old.test', now() - interval '3 months')", [id, team, owner]);
    await expect(asUser(member, "select public.prune_team_audit_log($1)", [team])).rejects.toThrow("Недостаточно прав");
    await asUser(owner, "select public.prune_team_audit_log($1)", [team]);
    expect((await db.query("select id from public.audit_log where id = $1", [id])).rows).toEqual([]);
  });

  test("granular team rights work for an ordinary employee, not only a manager", async () => {
    await expect(asUser(member, "update public.proxies set label = 'denied' where id = $1 returning id", [proxy])).resolves.toEqual([]);
    await expect(asUser(member, "select public.save_team_bookmark_defaults($1, '[]'::jsonb, true)", [team])).rejects.toThrow("Недостаточно прав");
    await asUser(owner, "select public.set_member_permissions($1, $2, true, true, false, false, true, true, true)", [team, member]);
    const rights = await asUser<{ can_manage_proxies: boolean; can_manage_bookmarks: boolean }>(member,
      "select can_manage_proxies, can_manage_bookmarks from public.member_permissions where team_id = $1 and user_id = $2", [team, member]);
    expect(rights).toEqual([{ can_manage_proxies: true, can_manage_bookmarks: true }]);
    expect(await asUser(member, "update public.proxies set label = 'employee' where id = $1 returning id", [proxy])).toEqual([{ id: proxy }]);
    const createdFolder = await asUser<{ id: string; name: string }>(member,
      "insert into public.profile_folders(team_id, name) values ($1, 'Employee folder') returning id, name", [team]);
    expect(createdFolder[0]!.name).toBe("Employee folder");
    await asUser(owner, "update public.browser_profiles set folder = 'Employee folder' where id = $1", [profile]);
    await asUser(owner, "select public.set_folder_access($1, 'Employee folder', $2, true)", [team, member]);
    await asUser(member, "select public.rename_team_folder($1, $2, 'Renamed folder')", [team, createdFolder[0]!.id]);
    expect((await db.query<{ folder: string }>("select folder from public.browser_profiles where id = $1", [profile])).rows[0]!.folder).toBe("Renamed folder");
    expect((await db.query<{ folder: string }>("select folder from public.folder_access where team_id = $1 and user_id = $2", [team, member])).rows[0]!.folder).toBe("Renamed folder");
    await asUser(member, "select public.delete_team_folder($1, $2)", [team, createdFolder[0]!.id]);
    expect((await db.query<{ folder: string }>("select folder from public.browser_profiles where id = $1", [profile])).rows[0]!.folder).toBe("Основная");
    expect(await asUser(member, "insert into public.profile_statuses(team_id, name, color) values ($1, 'Employee status', 'primary') returning name", [team])).toEqual([{ name: "Employee status" }]);
    expect(await asUser(member, "insert into public.profile_field_definitions(team_id, name, field_type) values ($1, 'Employee field', 'text') returning name", [team])).toEqual([{ name: "Employee field" }]);
    const saved = await asUser<{ value: { teamId: string } }>(member,
      "select public.save_team_bookmark_defaults($1, '[]'::jsonb, true) as value", [team]);
    expect(saved[0]!.value.teamId).toBe(team);
    await asUser(owner, "select public.set_member_permissions($1, $2, false, false, false, false, false, false, false)", [team, member]);
    expect(await asUser(member, "update public.proxies set label = 'denied' where id = $1 returning id", [proxy])).toEqual([]);
  });

  test("team bookmarks are shared with members but cannot cross team boundaries", async () => {
    const bookmarks = JSON.stringify([{ id: profile, title: "Почта", url: "https://mail.example.test/" }]);
    await asUser(owner, "select public.save_team_bookmark_defaults($1, $2::jsonb, true)", [team, bookmarks]);
    await asUser(outsider, "select public.save_team_bookmark_defaults($1, '[]'::jsonb, true)", [otherTeam]);
    expect(await asUser(member, "select team_id from public.team_bookmark_defaults")).toEqual([{ team_id: team }]);
    await expect(asUser(member, "select public.save_team_bookmark_defaults($1, '[]'::jsonb, true)", [team])).rejects.toThrow("Недостаточно прав");
    await expect(asUser(member, "select public.get_team_bookmark_defaults($1)", [otherTeam])).rejects.toThrow("Нет доступа");
    const rows = await asUser<{ value: { bookmarks: unknown[] } }>(member, "select public.get_team_bookmark_defaults($1) as value", [team]);
    expect(rows[0]!.value.bookmarks).toHaveLength(1);
  });
  test("members need explicit profile access, other teams never see the profile", async () => {
    expect(await asUser(member, "select id from public.browser_profiles")).toHaveLength(0);
    await asUser(owner, "select public.set_profiles_access($1, $2::uuid[], $3, true)", [team, [profile], member]);
    expect(await asUser(member, "select id from public.browser_profiles")).toEqual([{ id: profile }]);
    await expect(acquire(outsider)).rejects.toThrow("No profile access");
  });

  test("lease acquisition is exclusive even for the same owner", async () => {
    const results = await Promise.allSettled([acquire(), acquire(owner, "desktop-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await asUser(owner, "select public.force_profile_unlock($1)", [profile]);
  });

  test("token and device are enforced, lease tokens cannot be read or written directly", async () => {
    const lease = await acquire();
    await expect(mutate(crypto.randomUUID(), "save", "invalid")).rejects.toThrow("Session lease lost");
    await expect(mutate(lease.lockToken, "save", "invalid", member)).rejects.toThrow("Session lease lost");
    await expect(mutate(lease.lockToken, "heartbeat", null, owner, "wrong-device")).rejects.toThrow("Session lease lost");
    await expect(asUser(owner, "select lock_token from public.profile_locks")).rejects.toThrow("permission denied");
    await expect(asUser(owner, "delete from public.profile_locks")).rejects.toThrow("permission denied");
    await mutate(lease.lockToken, "close", "cipher-first");
  });

  test("close is idempotent after a lost response and cannot overwrite a later session", async () => {
    const lease = await acquire();
    const first = await mutate(lease.lockToken, "close", "cipher-second");
    const next = await acquire();
    await mutate(next.lockToken, "save", "cipher-newer");
    const replay = await mutate(lease.lockToken, "close", "must-not-replay");
    expect(replay[0]!.result.cookiesUpdatedAt).toEqual(first[0]!.result.cookiesUpdatedAt);
    expect((await db.query<{ cookies_enc: string }>("select cookies_enc from public.browser_profiles where id = $1", [profile])).rows[0]!.cookies_enc).toBe("cipher-newer");
    await mutate(next.lockToken, "close");
  });

  test("expired offline closure recovers only until a new device acquires the profile", async () => {
    const old = await acquire();
    await db.query("update public.profile_locks set expires_at = now() - interval '1 minute' where profile_id = $1", [profile]);
    await expect(mutate(old.lockToken, "save", "stale")).rejects.toThrow("Session lease lost");
    await mutate(old.lockToken, "close", "offline-close");
    const replaced = await acquire();
    await db.query("update public.profile_locks set expires_at = now() - interval '1 minute' where profile_id = $1", [profile]);
    const live = await acquire(owner, "desktop-b");
    await expect(mutate(replaced.lockToken, "close", "stale")).rejects.toThrow("Session lease lost");
    await mutate(live.lockToken, "close");
  });

  test("running profiles reject edits, imports and deletion, but accept a cookie save", async () => {
    const lease = await acquire();
    await expect(asUser(owner, "update public.browser_profiles set name = 'Changed' where id = $1", [profile])).rejects.toThrow("Close the profile");
    await expect(asUser(owner, "delete from public.browser_profiles where id = $1", [profile])).rejects.toThrow("permission denied");
    await expect(asUser(owner, "select public.import_profile_cookies($1, 'encrypted')", [profile])).rejects.toThrow("Close the profile");
    await expect(asUser(owner, "update public.proxies set port = 9090 where id = $1", [proxy])).rejects.toThrow("Close profiles using this proxy");
    await asUser(owner, "update public.proxies set last_check_ok = true where id = $1", [proxy]);
    await mutate(lease.lockToken, "save", "running-save");
    await mutate(lease.lockToken, "close");
  });

  test("bulk operations are atomic and reject cross-team selection", async () => {
    await expect(asUser(owner, "select public.bulk_mutate_profiles($1, $2::uuid[], 'update', $3::jsonb)", [team, [profile, otherProfile], JSON.stringify({ folder: "bad" })])).rejects.toThrow("cross-team");
    expect((await asUser<{ folder: string }>(owner, "select folder from public.browser_profiles where id = $1", [profile]))[0]!.folder).toBe("Основная");
    await asUser(owner, "select public.bulk_mutate_profiles($1, $2::uuid[], 'update', $3::jsonb)", [team, [profile], JSON.stringify({ folder: "Ready", tags: ["a", "b"] })]);
    expect((await asUser<{ folder: string }>(owner, "select folder from public.browser_profiles where id = $1", [profile]))[0]!.folder).toBe("Ready");
    await expect(asUser(member, "select public.bulk_mutate_profiles($1, $2::uuid[], 'delete', '{}'::jsonb)", [team, [profile]])).rejects.toThrow("Недостаточно прав для изменения профилей");
  });

  test("assigned proxies cannot disappear or be swapped across teams", async () => {
    await expect(asUser(owner, "delete from public.proxies where id = $1", [proxy])).rejects.toThrow("foreign key");
    await expect(asUser(outsider, "update public.browser_profiles set proxy_id = $1 where id = $2", [proxy, otherProfile])).rejects.toThrow("another team");
  });

  test("removing a member revokes profile access and running lease atomically", async () => {
    const old = await acquire(member);
    await asUser(owner, "select public.set_member_permissions($1, $2, false, false, false, false, false, true, false)", [team, member]);
    await asUser(owner, "select public.remove_team_member($1, $2)", [team, member]);
    expect((await db.query("select user_id from public.member_permissions where team_id = $1 and user_id = $2", [team, member])).rows).toHaveLength(0);
    expect(await asUser(member, "select id from public.proxies where id = $1", [proxy])).toEqual([]);
    expect(await asUser(member, "select id from public.browser_profiles")).toHaveLength(0);
    expect((await db.query("select * from public.profile_locks where profile_id = $1", [profile])).rows).toHaveLength(0);
    await expect(mutate(old.lockToken, "close", "revoked-cookies", member)).rejects.toThrow("No profile access");
    expect((await db.query<{ cookies_enc: string }>("select cookies_enc from public.browser_profiles where id = $1", [profile])).rows[0]!.cookies_enc).not.toBe("revoked-cookies");
    await expect(asUser(owner, "select public.set_profiles_access($1, $2::uuid[], $3, true)", [team, [profile], outsider])).rejects.toThrow("not a member");
  });

  test("invites require the verified matching email and cannot be replayed", async () => {
    const token = "a".repeat(64);
    await asUser(owner, "insert into public.team_invites(team_id, email, invited_by, token) values ($1, $2, $3, $4)", [team, "member@example.test", owner, token]);
    await expect(asUser(outsider, "select public.accept_team_invite($1)", [token])).rejects.toThrow("another email");
    await asUser(member, "select public.accept_team_invite($1)", [token]);
    await expect(asUser(member, "select public.accept_team_invite($1)", [token])).rejects.toThrow("unavailable");
    expect(await asUser(member, "select id from public.browser_profiles")).toHaveLength(0);
  });

  test("first workspace creation is repeatable and anonymous cannot acquire leases", async () => {
    const a = await asUser(owner, "select public.ensure_workspace() as id");
    expect(await asUser(owner, "select public.ensure_workspace() as id")).toEqual(a);
    await expect(db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query("select public.acquire_profile_lease($1, 'device')", [profile]);
    })).rejects.toThrow("permission denied");
  });

  test("a new user without membership gets no workspace and author deletion preserves shared profiles", async () => {
    const fresh = "10000000-0000-4000-8000-000000000004";
    await db.query("insert into auth.users(id, email, email_confirmed_at) values ($1, 'fresh@example.test', now())", [fresh]);
    // Рабочие пространства не создаются автоматически: доступ даёт только членство в команде.
    await expect(asUser(fresh, "select public.ensure_workspace() as id")).rejects.toThrow("ещё не добавлена в команду");
    await db.query("insert into public.team_members(team_id, user_id, role) values ($1, $2, 'member')", [team, fresh]);
    const first = await asUser(fresh, "select public.ensure_workspace() as id");
    expect(first).toEqual([{ id: team }]);
    expect(await asUser(fresh, "select public.ensure_workspace() as id")).toEqual(first);
    const shared = "30000000-0000-4000-8000-000000000003";
    await db.query("insert into public.browser_profiles(id, team_id, name, created_by) values ($1, $2, 'Shared', $3)", [shared, team, fresh]);
    await db.query("delete from auth.users where id = $1", [fresh]);
    expect((await db.query<{ created_by: string | null }>("select created_by from public.browser_profiles where id = $1", [shared])).rows[0]!.created_by).toBeNull();
  });
});

