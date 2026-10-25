const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261025113100_availability_probe.sql'), 'utf8');

test('availability is constant, invoker-only and leaves existing data and permissions untouched', async () => {
  const db = await PGlite.create();
  const asRole = (role, sql) => db.transaction(async tx => {
    assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query(sql)).rows;
  });
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE TABLE public.availability_canary(id integer PRIMARY KEY, synthetic_ciphertext text);
      INSERT INTO public.availability_canary VALUES (1, 'synthetic-only-untouched');
      ALTER TABLE public.availability_canary ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.availability_canary TO authenticated;
      CREATE POLICY original_policy ON public.availability_canary FOR SELECT TO authenticated USING (true);
      CREATE FUNCTION public.original_public_function() RETURNS integer LANGUAGE sql AS $$ SELECT 7 $$;
    `);
    const original = (await db.query(`SELECT relacl::text, relrowsecurity FROM pg_class WHERE oid='public.availability_canary'::regclass`)).rows;
    const policies = (await db.query(`SELECT policyname, roles, cmd, qual FROM pg_policies WHERE tablename='availability_canary'`)).rows;
    await db.exec(migration);
    assert.deepEqual(await asRole('anon', 'SELECT public.umbra_availability() AS ok'), [{ ok: true }]);
    await assert.rejects(asRole('anon', 'SELECT * FROM public.availability_canary'), error => error.code === '42501');
    for (const role of ['authenticated', 'service_role']) {
      await assert.rejects(asRole(role, 'SELECT public.umbra_availability()'), error => error.code === '42501');
    }
    assert.deepEqual(await asRole('authenticated', 'SELECT * FROM public.availability_canary'), [{ id: 1, synthetic_ciphertext: 'synthetic-only-untouched' }]);
    assert.deepEqual(await asRole('anon', 'SELECT public.original_public_function() AS n'), [{ n: 7 }]);
    assert.deepEqual((await db.query(`SELECT relacl::text, relrowsecurity FROM pg_class WHERE oid='public.availability_canary'::regclass`)).rows, original);
    assert.deepEqual((await db.query(`SELECT policyname, roles, cmd, qual FROM pg_policies WHERE tablename='availability_canary'`)).rows, policies);
    const metadata = (await db.query(`SELECT prosecdef, provolatile, pronargs, proconfig, prosrc FROM pg_proc WHERE oid='public.umbra_availability()'::regprocedure`)).rows[0];
    assert.equal(metadata.prosecdef, false);
    assert.equal(metadata.provolatile, 's');
    assert.equal(metadata.pronargs, 0);
    assert.deepEqual(metadata.proconfig, ['search_path=pg_catalog']);
    assert.equal(metadata.prosrc.trim(), 'SELECT true');
    const publicExecution = (await db.query(`SELECT count(*)::integer AS n FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.oid='public.umbra_availability()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows[0].n;
    assert.equal(publicExecution, 0);
    // A replay/collision must fail, not silently replace a function or its ACL.
    await assert.rejects(db.exec(migration), error => error.code === '42723');
    await db.exec('ROLLBACK');
    assert.deepEqual(await asRole('anon', 'SELECT public.umbra_availability() AS ok'), [{ ok: true }]);
  } finally {
    await db.close();
  }
});
