-- The former empty location becomes the owner's only private "Основная".
-- Keep the folder row so every team has one stable, non-shareable home.
INSERT INTO public.profile_folders(team_id, name, is_default, position)
SELECT t.id, 'Основная', true, 0 FROM public.teams t
WHERE NOT EXISTS (SELECT 1 FROM public.profile_folders f WHERE f.team_id = t.id AND f.name = 'Основная');
UPDATE public.profile_folders SET is_default = true, position = 0 WHERE name = 'Основная' AND NOT is_default;

CREATE OR REPLACE FUNCTION private.create_main_folder_for_team()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  INSERT INTO public.profile_folders(team_id, name, is_default, position)
    VALUES (NEW.id, 'Основная', true, 0)
    ON CONFLICT (team_id, name) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS create_main_folder_for_team ON public.teams;
CREATE TRIGGER create_main_folder_for_team AFTER INSERT ON public.teams
  FOR EACH ROW EXECUTE FUNCTION private.create_main_folder_for_team();

-- If an employee was explicitly allowed to create folders, their newly
-- created folder must be usable by them without exposing any owner folders.
CREATE OR REPLACE FUNCTION private.grant_created_folder_to_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF NOT NEW.is_default AND NEW.created_by IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.team_members m
    WHERE m.team_id = NEW.team_id AND m.user_id = NEW.created_by AND m.role = 'member'
  ) THEN
    INSERT INTO public.folder_access(team_id, folder, user_id, granted_by)
      VALUES (NEW.team_id, NEW.name, NEW.created_by, NEW.created_by)
      ON CONFLICT (team_id, folder, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS grant_created_folder_to_member ON public.profile_folders;
CREATE TRIGGER grant_created_folder_to_member AFTER INSERT ON public.profile_folders
  FOR EACH ROW EXECUTE FUNCTION private.grant_created_folder_to_member();

-- Preserve active and trashed profiles. A deleted profile is restored into
-- the same private home, never into a former employee-accessible location.
UPDATE public.browser_profiles SET folder = 'Основная' WHERE folder = '';
DELETE FROM public.folder_access WHERE folder IN ('', 'Основная');
DELETE FROM public.profile_access a USING public.browser_profiles p
  WHERE a.profile_id = p.id AND p.folder = 'Основная';

-- Old imports can contain folders without a profile_folders row. Materialize
-- these folders so they can actually be renamed and sorted, including when
-- their profiles currently happen to be in the trash.
INSERT INTO public.profile_folders(team_id, name, is_default)
SELECT DISTINCT p.team_id, p.folder, false FROM public.browser_profiles p
WHERE p.folder NOT IN ('', 'Основная')
  AND NOT EXISTS (SELECT 1 FROM public.profile_folders f WHERE f.team_id = p.team_id AND f.name = p.folder)
ON CONFLICT (team_id, name) DO NOTHING;

CREATE OR REPLACE FUNCTION private.can_use_folder(_user_id uuid, _team_id uuid, _folder text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT CASE WHEN _folder IN ('', 'Основная') THEN
    private.has_role(_user_id, _team_id, 'owner'::public.app_role)
  ELSE private.can_manage(_user_id, _team_id)
    OR EXISTS (SELECT 1 FROM public.folder_access fa
      WHERE fa.team_id = _team_id AND fa.folder = _folder AND fa.user_id = _user_id)
  END
$$;

CREATE OR REPLACE FUNCTION private.has_folder_profile_access(_user_id uuid, _profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.browser_profiles p
    JOIN public.folder_access fa ON fa.team_id = p.team_id AND fa.folder = p.folder AND fa.user_id = _user_id
    WHERE p.id = _profile_id AND p.folder NOT IN ('', 'Основная'))
$$;

CREATE OR REPLACE FUNCTION private.can_access_profile(_user_id uuid, _profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.browser_profiles p WHERE p.id = _profile_id
    AND p.deleted_at IS NULL AND (
      private.has_role(_user_id, p.team_id, 'owner'::public.app_role)
      OR (p.folder NOT IN ('', 'Основная') AND (
        private.can_manage(_user_id, p.team_id)
        OR private.has_folder_profile_access(_user_id, p.id)
      ))))
$$;

DROP POLICY IF EXISTS "bp manager all" ON public.browser_profiles;
CREATE POLICY "bp manager all" ON public.browser_profiles FOR ALL TO authenticated
  USING (private.can_manage(auth.uid(), team_id) AND private.can_use_folder(auth.uid(), team_id, folder))
  WITH CHECK (private.can_manage(auth.uid(), team_id) AND private.can_use_folder(auth.uid(), team_id, folder));
DROP POLICY IF EXISTS "bp member read" ON public.browser_profiles;
CREATE POLICY "bp member read" ON public.browser_profiles FOR SELECT TO authenticated
  USING (private.can_use_folder(auth.uid(), team_id, folder) AND (
    private.can_manage(auth.uid(), team_id)
    OR private.has_folder_profile_access(auth.uid(), id)));

DROP POLICY IF EXISTS "folders team read" ON public.profile_folders;
CREATE POLICY "folders team read" ON public.profile_folders FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.team_members m
    WHERE m.team_id = profile_folders.team_id AND m.user_id = auth.uid())
    AND (NOT is_default OR private.has_role(auth.uid(), team_id, 'owner'::public.app_role)));
DROP POLICY IF EXISTS "folders permitted write" ON public.profile_folders;
CREATE POLICY "folders permitted write" ON public.profile_folders FOR ALL TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'folder.manage') AND NOT is_default)
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'folder.manage')
    AND NOT is_default AND lower(btrim(name)) <> lower('Основная'));

CREATE OR REPLACE FUNCTION public.set_folder_access(_team_id uuid, _folder text, _user_id uuid, _granted boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.can_manage(auth.uid(), _team_id) THEN
    RAISE EXCEPTION 'Недостаточно прав для выдачи доступа к папке' USING ERRCODE = '42501';
  END IF;
  IF _folder IS NULL OR length(btrim(_folder)) NOT BETWEEN 1 AND 200 OR _granted IS NULL
    OR lower(btrim(_folder)) = lower('Основная') THEN
    RAISE EXCEPTION 'Основная папка личная и не может быть открыта сотруднику' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profile_folders WHERE team_id = _team_id AND name = _folder AND NOT is_default) THEN
    RAISE EXCEPTION 'Папка не найдена' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_members WHERE team_id = _team_id AND user_id = _user_id) THEN
    RAISE EXCEPTION 'Пользователь не состоит в команде' USING ERRCODE = '42501';
  END IF;
  IF _granted THEN
    INSERT INTO public.folder_access(team_id, folder, user_id, granted_by)
      VALUES (_team_id, _folder, _user_id, auth.uid())
      ON CONFLICT (team_id, folder, user_id) DO NOTHING;
  ELSE
    DELETE FROM public.folder_access WHERE team_id = _team_id AND folder = _folder AND user_id = _user_id;
  END IF;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    VALUES (_team_id, auth.uid(), 'folder.access_changed', 'member', _user_id,
      jsonb_build_object('folder', _folder, 'granted', _granted));
  RETURN true;
END $$;
