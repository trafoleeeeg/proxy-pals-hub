CREATE OR REPLACE FUNCTION public.prune_team_audit_log(_team_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE removed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT (
    private.has_role(auth.uid(), _team_id, 'owner')
    OR EXISTS (SELECT 1 FROM public.team_members WHERE team_id = _team_id AND user_id = auth.uid() AND scope = 'manager')
    OR public.is_superadmin()
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав для просмотра журнала' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.audit_log WHERE team_id = _team_id AND created_at < clock_timestamp() - interval '2 months';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION public.prune_team_audit_log(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.prune_team_audit_log(uuid) TO authenticated;

-- В базе Supabase с pg_cron ежедневная очистка работает и без открытия панели.
-- Для локальных БД без pg_cron очистка также выполняется при чтении журнала.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $schedule$SELECT cron.schedule('umbra-audit-retention', '15 3 * * *', 'DELETE FROM public.audit_log WHERE created_at < clock_timestamp() - interval ''2 months''')$schedule$;
  END IF;
END $$;
