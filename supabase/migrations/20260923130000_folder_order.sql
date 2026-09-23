ALTER TABLE public.profile_folders ADD COLUMN position integer NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY team_id ORDER BY is_default DESC, name) - 1 AS number
  FROM public.profile_folders
)
UPDATE public.profile_folders f SET position = ranked.number FROM ranked WHERE f.id = ranked.id;

CREATE OR REPLACE FUNCTION public.assign_folder_position()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  IF NOT NEW.is_default AND NEW.position = 0 THEN
    SELECT coalesce(max(position), 0) + 1 INTO NEW.position
      FROM public.profile_folders WHERE team_id = NEW.team_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assign_folder_position_before_insert BEFORE INSERT ON public.profile_folders
  FOR EACH ROW EXECUTE FUNCTION public.assign_folder_position();

CREATE OR REPLACE FUNCTION public.reorder_team_folders(_team_id uuid, _folder_ids uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE expected integer;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'folder.manage') THEN
    RAISE EXCEPTION 'Недостаточно прав для сортировки папок' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO expected FROM public.profile_folders WHERE team_id = _team_id AND NOT is_default;
  IF _folder_ids IS NULL OR cardinality(_folder_ids) <> expected
    OR (SELECT count(DISTINCT requested.folder_id) FROM unnest(_folder_ids) AS requested(folder_id)) <> expected
    OR EXISTS (SELECT 1 FROM unnest(_folder_ids) AS requested(folder_id)
      WHERE NOT EXISTS (SELECT 1 FROM public.profile_folders f WHERE f.id = requested.folder_id AND f.team_id = _team_id AND NOT f.is_default)) THEN
    RAISE EXCEPTION 'Некорректный порядок папок' USING ERRCODE = '22023';
  END IF;
  UPDATE public.profile_folders f SET position = ordering.ordinality::integer
    FROM unnest(_folder_ids) WITH ORDINALITY AS ordering(id, ordinality)
    WHERE f.id = ordering.id AND f.team_id = _team_id AND NOT f.is_default;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id)
    VALUES (_team_id, auth.uid(), 'folders.reordered', 'team', _team_id);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.reorder_team_folders(uuid, uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reorder_team_folders(uuid, uuid[]) TO authenticated;
