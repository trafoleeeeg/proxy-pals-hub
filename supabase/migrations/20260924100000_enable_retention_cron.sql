-- The production database has pg_cron available but not enabled. Without it,
-- retention only runs when someone opens the journal or trash page.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- A named schedule is updated instead of duplicated if an earlier migration
-- already registered it on a database with pg_cron enabled.
SELECT cron.schedule(
  'umbra-audit-retention',
  '15 3 * * *',
  $$DELETE FROM public.audit_log
      WHERE created_at < clock_timestamp() - interval '2 months'$$
);

SELECT cron.schedule(
  'umbra-profile-trash-retention',
  '45 3 * * *',
  $$DELETE FROM public.browser_profiles
      WHERE deleted_at < clock_timestamp() - interval '14 days'$$
);
