CREATE OR REPLACE FUNCTION public.ensure_workspace()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  team_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT t.id INTO team_id
  FROM public.teams t
  WHERE private.is_superadmin(auth.uid())
     OR t.owner_id = auth.uid()
     OR EXISTS (
       SELECT 1 FROM public.team_members m
       WHERE m.team_id = t.id AND m.user_id = auth.uid()
     )
  ORDER BY CASE WHEN private.is_superadmin(auth.uid()) THEN 0 ELSE 1 END, t.created_at, t.id
  LIMIT 1;

  IF team_id IS NULL THEN
    RAISE EXCEPTION 'Учётная запись ещё не добавлена в команду Umbra' USING ERRCODE = '42501';
  END IF;

  RETURN team_id;
END
$$;

REVOKE ALL ON FUNCTION public.ensure_workspace() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ensure_workspace() TO authenticated;