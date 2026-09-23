-- Older profiles and newly created unfiled profiles use an empty folder name.
-- Keep them visually separate as "Без папки", but grant access through the
-- default folder so members with "Основная" are not locked out of them.
CREATE OR REPLACE FUNCTION private.has_folder_profile_access(_user_id uuid, _profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.browser_profiles p
    JOIN public.folder_access fa
      ON fa.team_id = p.team_id
      AND fa.folder = coalesce(nullif(p.folder, ''), 'Основная')
      AND fa.user_id = _user_id
    WHERE p.id = _profile_id AND p.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION private.can_use_folder(_user_id uuid, _team_id uuid, _folder text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT private.can_manage(_user_id, _team_id)
    OR EXISTS (
      SELECT 1 FROM public.folder_access fa
      WHERE fa.team_id = _team_id
        AND fa.folder = coalesce(nullif(_folder, ''), 'Основная')
        AND fa.user_id = _user_id
    )
$$;

DROP POLICY IF EXISTS "bp member read" ON public.browser_profiles;
CREATE POLICY "bp member read" ON public.browser_profiles
  FOR SELECT TO authenticated
  USING (
    private.can_manage(auth.uid(), team_id)
    OR private.has_profile_access(auth.uid(), id)
    OR EXISTS (
      SELECT 1 FROM public.folder_access fa
      WHERE fa.team_id = browser_profiles.team_id
        AND fa.folder = coalesce(nullif(browser_profiles.folder, ''), 'Основная')
        AND fa.user_id = auth.uid()
    )
  );

