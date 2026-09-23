-- Order is scoped to a team's folder. A new profile starts at the top until
-- the next explicit reorder; existing profiles retain their current date order.
ALTER TABLE public.browser_profiles ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

-- Moving a row must not falsely mark profile settings/cookies as changed.
CREATE FUNCTION private.set_profile_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  IF to_jsonb(NEW) - 'sort_order' IS DISTINCT FROM to_jsonb(OLD) - 'sort_order' THEN
    NEW.updated_at := now();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER bp_updated ON public.browser_profiles;
CREATE TRIGGER bp_updated BEFORE UPDATE ON public.browser_profiles
  FOR EACH ROW EXECUTE FUNCTION private.set_profile_updated_at();
REVOKE ALL ON FUNCTION private.set_profile_updated_at() FROM public, anon, authenticated;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY team_id, folder ORDER BY created_at DESC, id)::integer AS position
  FROM public.browser_profiles
)
UPDATE public.browser_profiles p SET sort_order = ranked.position
  FROM ranked WHERE p.id = ranked.id;

CREATE FUNCTION public.reorder_team_profiles(_team_id uuid, _folder text, _profile_ids uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE expected integer;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'profile.edit')
    OR NOT private.can_use_folder(auth.uid(), _team_id, _folder) THEN
    RAISE EXCEPTION 'Недостаточно прав для сортировки профилей' USING ERRCODE = '42501';
  END IF;
  IF _folder IS NULL OR length(_folder) NOT BETWEEN 1 AND 200 OR _profile_ids IS NULL
    OR cardinality(_profile_ids) NOT BETWEEN 2 AND 5000 THEN
    RAISE EXCEPTION 'Некорректный порядок профилей' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profile_folders WHERE team_id = _team_id AND name = _folder) THEN
    RAISE EXCEPTION 'Папка недоступна' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_team_id::text || ':' || _folder, 0));
  SELECT count(*) INTO expected FROM public.browser_profiles
    WHERE team_id = _team_id AND folder = _folder AND deleted_at IS NULL;
  IF cardinality(_profile_ids) <> expected
    OR (SELECT count(DISTINCT id) FROM unnest(_profile_ids) AS requested(id)) <> expected
    OR EXISTS (SELECT 1 FROM unnest(_profile_ids) AS requested(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.browser_profiles p
        WHERE p.id = requested.id AND p.team_id = _team_id
          AND p.folder = _folder AND p.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Список профилей изменился. Обновите страницу и повторите' USING ERRCODE = '22023';
  END IF;
  UPDATE public.browser_profiles p SET sort_order = ordering.ordinality::integer
    FROM unnest(_profile_ids) WITH ORDINALITY AS ordering(id, ordinality)
    WHERE p.id = ordering.id AND p.team_id = _team_id AND p.folder = _folder AND p.deleted_at IS NULL;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, meta)
    VALUES (_team_id, auth.uid(), 'profiles.reordered', 'profile',
      jsonb_build_object('folder', _folder, 'count', expected));
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.reorder_team_profiles(uuid, text, uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reorder_team_profiles(uuid, text, uuid[]) TO authenticated;

