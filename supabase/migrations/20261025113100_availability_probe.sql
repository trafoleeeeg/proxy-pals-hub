-- A zero-data PostgreSQL availability probe for the external scheduled monitor.
-- No profile, cookie, proxy, Auth or application table access is required.
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION public.umbra_availability()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION public.umbra_availability()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.umbra_availability() TO anon;

COMMENT ON FUNCTION public.umbra_availability() IS
  'Read-only database availability: returns true, accepts no input, accesses no tables.';
NOTIFY pgrst, 'reload schema';
COMMIT;
