import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

describe("private main folder rollout", () => {
  test("keeps existing profiles and cookies, revokes old grants, and materializes shared folders", async () => {
    const db = await PGlite.create();
    const owner = "10000000-0000-4000-8000-000000000011";
    const member = "10000000-0000-4000-8000-000000000012";
    const team = "20000000-0000-4000-8000-000000000011";
    const privateProfile = "30000000-0000-4000-8000-000000000011";
    const sharedProfile = "30000000-0000-4000-8000-000000000012";
    const trashedProfile = "30000000-0000-4000-8000-000000000013";
    const asUser = async (user: string, sql: string) => db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
      await tx.exec("set local role authenticated");
      return (await tx.query(sql)).rows;
    });
    try {
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
      const rollout = "20260924120000_private_main_folder.sql";
      for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql") && name !== rollout).sort()) {
        if (file === "20260924100000_enable_retention_cron.sql") continue;
        if (file.startsWith("20260919215434_")) {
          await db.query("insert into auth.users(id, email, email_confirmed_at) values ('8f9bf3e6-def2-47ac-938a-d37c7f6b33ff', 'owner@migration.test', now())");
          await db.query("insert into public.teams(id, owner_id) values ('edab663b-a15f-4f9c-a914-fca4bce85d7e', '8f9bf3e6-def2-47ac-938a-d37c7f6b33ff')");
        }
        await db.exec(await readFile(`${dir}/${file}`, "utf8"));
      }
      await db.query("insert into auth.users(id, email, email_confirmed_at) values ($1, 'owner2@migration.test', now()), ($2, 'member@migration.test', now())", [owner, member]);
      await db.query("insert into public.teams(id, owner_id) values ($1, $2)", [team, owner]);
      await db.query("insert into public.team_members(team_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member')", [team, owner, member]);
      await db.query("insert into public.profile_folders(team_id, name, is_default) values ($1, 'Основная', true)", [team]);
      await db.query("insert into public.browser_profiles(id, team_id, name, folder, cookies_enc) values ($1, $2, 'Private', '', 'cipher-private'), ($3, $2, 'Shared', 'Shared', 'cipher-shared'), ($4, $2, 'Trashed', '', 'cipher-trash')", [privateProfile, team, sharedProfile, trashedProfile]);
      await db.query("update public.browser_profiles set deleted_at = now() where id = $1", [trashedProfile]);
      await asUser(owner, `select public.set_folder_access('${team}', '', '${member}', true)`);
      await asUser(owner, `select public.set_folder_access('${team}', 'Основная', '${member}', true)`);
      await asUser(owner, `select public.set_folder_access('${team}', 'Shared', '${member}', true)`);
      await asUser(owner, `select public.set_profiles_access('${team}', array['${privateProfile}']::uuid[], '${member}', true)`);
      expect(await asUser(member, `select id from public.browser_profiles where id = '${privateProfile}'`)).toHaveLength(1);

      await db.exec(await readFile(`${dir}/${rollout}`, "utf8"));
      expect((await db.query<{ folder: string; cookies_enc: string }>("select folder, cookies_enc from public.browser_profiles where id = $1", [privateProfile])).rows).toEqual([{ folder: "Основная", cookies_enc: "cipher-private" }]);
      expect((await db.query<{ folder: string; cookies_enc: string }>("select folder, cookies_enc from public.browser_profiles where id = $1", [trashedProfile])).rows).toEqual([{ folder: "Основная", cookies_enc: "cipher-trash" }]);
      expect((await db.query<{ folder: string }>("select folder from public.folder_access where team_id = $1", [team])).rows).toEqual([{ folder: "Shared" }]);
      expect((await db.query<{ name: string }>("select name from public.profile_folders where team_id = $1 order by name", [team])).rows).toEqual([{ name: "Shared" }, { name: "Основная" }]);
      expect(await asUser(member, "select name from public.browser_profiles")).toEqual([{ name: "Shared" }]);
      expect(await asUser(owner, "select name from public.browser_profiles order by name")).toEqual([{ name: "Private" }, { name: "Shared" }]);
      expect(await asUser(member, `select name from public.profile_folders where team_id = '${team}'`)).toEqual([{ name: "Shared" }]);
      await expect(asUser(owner, `select public.set_folder_access('${team}', 'Основная', '${member}', true)`)).rejects.toThrow("личная");
    } finally { await db.close(); }
  }, 30000);
});
