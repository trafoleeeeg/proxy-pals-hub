-- The panel grants granular rights to members. Keep table policies and the
-- bookmark RPC in sync with those rights instead of requiring manager scope.
CREATE OR REPLACE FUNCTION private.has_permission(_user_id uuid, _team_id uuid, _perm text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
DECLARE flag boolean;
BEGIN
  IF private.can_manage(_user_id, _team_id) THEN RETURN true; END IF;
  IF NOT private.is_team_member(_user_id, _team_id) THEN RETURN false; END IF;
  IF _perm = 'profile.create' THEN
    SELECT can_create_profile INTO flag FROM public.member_permissions WHERE team_id = _team_id AND user_id = _user_id;
  ELSIF _perm = 'profile.edit' THEN
    SELECT can_edit_profile INTO flag FROM public.member_permissions WHERE team_id = _team_id AND user_id = _user_id;
  ELSIF _perm = 'profile.delete' THEN
    SELECT can_delete_profile INTO flag FROM public.member_permissions WHERE team_id = _team_id AND user_id = _user_id;
  ELSIF _perm = 'profile.proxy' THEN
    SELECT can_change_profile_proxy INTO flag FROM public.member_permissions WHERE team_id = _team_id AND user_id = _user_id;
  ELSIF _perm = 'folder.manage' THEN
    SELECT can_manage_folders INTO flag FROM public.member_permissions WHERE team_id = _team_id AND user_id = _user_id;
  ELSIF _perm = 'proxy.manage' THEN
    SELECT can_manage_proxies INTO flag FROM public.member_permissions WHERE team_id = _team_id AND user_id = _user_id;
  ELSIF _perm = 'bookmarks.manage' THEN
    SELECT can_manage_bookmarks INTO flag FROM public.member_permissions WHERE team_id = _team_id AND user_id = _user_id;
  ELSE
    RETURN false;
  END IF;
  RETURN coalesce(flag, false);
END $$;

CREATE OR REPLACE FUNCTION private.cleanup_member_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  DELETE FROM public.profile_access a USING public.browser_profiles p
    WHERE a.profile_id = p.id AND p.team_id = old.team_id AND a.user_id = old.user_id;
  DELETE FROM public.profile_locks l USING public.browser_profiles p
    WHERE l.profile_id = p.id AND p.team_id = old.team_id AND l.user_id = old.user_id;
  DELETE FROM public.member_permissions WHERE team_id = old.team_id AND user_id = old.user_id;
  DELETE FROM public.folder_access WHERE team_id = old.team_id AND user_id = old.user_id;
  RETURN old;
END $$;

DROP POLICY IF EXISTS "proxies manager all" ON public.proxies;
CREATE POLICY "proxies permitted write" ON public.proxies FOR ALL TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'proxy.manage'))
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'proxy.manage'));
DROP POLICY IF EXISTS "proxies member read" ON public.proxies;
CREATE POLICY "proxies member read" ON public.proxies FOR SELECT TO authenticated
  USING (private.is_team_member(auth.uid(), team_id) AND EXISTS (
    SELECT 1 FROM public.browser_profiles bp WHERE bp.proxy_id = proxies.id
      AND private.can_access_profile(auth.uid(), bp.id)
  ));

DROP POLICY IF EXISTS "folders manager write" ON public.profile_folders;
CREATE POLICY "folders permitted write" ON public.profile_folders FOR ALL TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'folder.manage'))
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'folder.manage') AND length(btrim(name)) BETWEEN 1 AND 200);

DROP POLICY IF EXISTS "status manager insert" ON public.profile_statuses;
DROP POLICY IF EXISTS "status manager update" ON public.profile_statuses;
DROP POLICY IF EXISTS "status manager delete" ON public.profile_statuses;
CREATE POLICY "status permitted insert" ON public.profile_statuses FOR INSERT TO authenticated
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'profile.edit'));
CREATE POLICY "status permitted update" ON public.profile_statuses FOR UPDATE TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'profile.edit'))
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'profile.edit'));
CREATE POLICY "status permitted delete" ON public.profile_statuses FOR DELETE TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'profile.edit'));

DROP POLICY IF EXISTS "field manager insert" ON public.profile_field_definitions;
DROP POLICY IF EXISTS "field manager update" ON public.profile_field_definitions;
DROP POLICY IF EXISTS "field manager delete" ON public.profile_field_definitions;
CREATE POLICY "field permitted insert" ON public.profile_field_definitions FOR INSERT TO authenticated
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'profile.edit'));
CREATE POLICY "field permitted update" ON public.profile_field_definitions FOR UPDATE TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'profile.edit'))
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'profile.edit'));
CREATE POLICY "field permitted delete" ON public.profile_field_definitions FOR DELETE TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'profile.edit'));

DROP POLICY IF EXISTS "team bookmark defaults manage" ON public.team_bookmark_defaults;
CREATE POLICY "team bookmark defaults permitted write" ON public.team_bookmark_defaults FOR ALL TO authenticated
  USING (private.has_permission(auth.uid(), team_id, 'bookmarks.manage'))
  WITH CHECK (private.has_permission(auth.uid(), team_id, 'bookmarks.manage'));

CREATE OR REPLACE FUNCTION public.save_team_bookmark_defaults(_team_id uuid, _bookmarks jsonb, _bookmark_bar_visible boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE saved public.team_bookmark_defaults;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'bookmarks.manage') THEN
    RAISE EXCEPTION 'Недостаточно прав для изменения закладок команды' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.team_bookmark_defaults(team_id, bookmarks, bookmark_bar_visible, revision, updated_by)
  VALUES (_team_id, _bookmarks, _bookmark_bar_visible, 1, auth.uid())
  ON CONFLICT (team_id) DO UPDATE SET
    bookmarks = excluded.bookmarks,
    bookmark_bar_visible = excluded.bookmark_bar_visible,
    revision = public.team_bookmark_defaults.revision + 1,
    updated_by = auth.uid()
  RETURNING * INTO saved;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id, meta)
  VALUES (_team_id, auth.uid(), 'bookmarks.defaults_saved', 'team', _team_id, jsonb_build_object('count', jsonb_array_length(_bookmarks)));
  RETURN jsonb_build_object(
    'teamId', saved.team_id, 'bookmarks', saved.bookmarks,
    'bookmarkBarVisible', saved.bookmark_bar_visible, 'revision', saved.revision,
    'updatedAt', saved.updated_at
  );
END $$;

-- Moving profiles and access rows with a folder must be one transaction. A
-- member's folder.manage right is sufficient, without granting profile.edit.
CREATE OR REPLACE FUNCTION public.rename_team_folder(_team_id uuid, _folder_id uuid, _name text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE old_name text; is_default_folder boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'folder.manage') THEN
    RAISE EXCEPTION 'Недостаточно прав для изменения папки' USING ERRCODE = '42501';
  END IF;
  IF _name IS NULL OR length(btrim(_name)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Некорректное название папки' USING ERRCODE = '22023';
  END IF;
  SELECT name, is_default INTO old_name, is_default_folder FROM public.profile_folders
    WHERE id = _folder_id AND team_id = _team_id FOR UPDATE;
  IF NOT FOUND OR is_default_folder THEN
    RAISE EXCEPTION 'Папка недоступна для переименования' USING ERRCODE = '42501';
  END IF;
  UPDATE public.browser_profiles SET folder = btrim(_name)
    WHERE team_id = _team_id AND folder = old_name;
  UPDATE public.folder_access SET folder = btrim(_name)
    WHERE team_id = _team_id AND folder = old_name;
  UPDATE public.profile_folders SET name = btrim(_name)
    WHERE id = _folder_id AND team_id = _team_id;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id)
    VALUES (_team_id, auth.uid(), 'folder.renamed', 'folder', _folder_id);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.delete_team_folder(_team_id uuid, _folder_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE old_name text; is_default_folder boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'folder.manage') THEN
    RAISE EXCEPTION 'Недостаточно прав для удаления папки' USING ERRCODE = '42501';
  END IF;
  SELECT name, is_default INTO old_name, is_default_folder FROM public.profile_folders
    WHERE id = _folder_id AND team_id = _team_id FOR UPDATE;
  IF NOT FOUND OR is_default_folder THEN
    RAISE EXCEPTION 'Основную или чужую папку удалить нельзя' USING ERRCODE = '42501';
  END IF;
  UPDATE public.browser_profiles SET folder = 'Основная'
    WHERE team_id = _team_id AND folder = old_name;
  DELETE FROM public.folder_access WHERE team_id = _team_id AND folder = old_name;
  DELETE FROM public.profile_folders WHERE id = _folder_id AND team_id = _team_id;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id)
    VALUES (_team_id, auth.uid(), 'folder.deleted', 'folder', _folder_id);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.rename_team_folder(uuid, uuid, text), public.delete_team_folder(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rename_team_folder(uuid, uuid, text), public.delete_team_folder(uuid, uuid) TO authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'member_permissions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.member_permissions;
  END IF;
END $$;
