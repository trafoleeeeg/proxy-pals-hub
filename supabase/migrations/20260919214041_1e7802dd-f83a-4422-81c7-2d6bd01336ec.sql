CREATE OR REPLACE FUNCTION public.remove_team_member(_team_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_role(auth.uid(), _team_id, 'owner')
    OR private.has_role(_user_id, _team_id, 'owner')
    OR private.is_superadmin(_user_id) THEN
    RAISE EXCEPTION 'Cannot remove this team member' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.team_members WHERE team_id = _team_id AND user_id = _user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team member not found' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id)
    VALUES (_team_id, auth.uid(), 'member.removed', 'member', _user_id);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.set_member_scope(_team_id uuid, _user_id uuid, _scope text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_role(auth.uid(), _team_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Только владелец команды меняет уровень доступа' USING ERRCODE = '42501';
  END IF;
  IF _scope IS NULL OR _scope NOT IN ('member','manager') THEN
    RAISE EXCEPTION 'Некорректный уровень доступа' USING ERRCODE = '22023';
  END IF;
  IF private.has_role(_user_id, _team_id, 'owner'::public.app_role)
    OR private.is_superadmin(_user_id) THEN
    RAISE EXCEPTION 'Уровень доступа владельца изменить нельзя' USING ERRCODE = '42501';
  END IF;
  UPDATE public.team_members SET scope = _scope WHERE team_id = _team_id AND user_id = _user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Участник команды не найден' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    VALUES (_team_id, auth.uid(), 'member.scope_changed', 'member', _user_id, jsonb_build_object('scope', _scope));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.set_member_permissions(_team_id uuid, _user_id uuid, _create boolean, _edit boolean, _delete boolean, _proxy boolean, _folders boolean, _proxies boolean, _bookmarks boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_role(auth.uid(), _team_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Только владелец команды может менять права' USING ERRCODE = '42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.teams WHERE id = _team_id AND owner_id = _user_id)
     OR private.is_superadmin(_user_id) THEN
    RAISE EXCEPTION 'Права владельца изменить нельзя' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.team_members WHERE team_id = _team_id AND user_id = _user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Пользователь не состоит в команде' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.member_permissions(team_id, user_id, can_create_profile, can_edit_profile, can_delete_profile,
    can_change_profile_proxy, can_manage_folders, can_manage_proxies, can_manage_bookmarks, updated_by, updated_at)
  VALUES (_team_id, _user_id, _create, _edit, _delete, _proxy, _folders, _proxies, _bookmarks, auth.uid(), now())
  ON CONFLICT (team_id, user_id) DO UPDATE SET
    can_create_profile = EXCLUDED.can_create_profile,
    can_edit_profile = EXCLUDED.can_edit_profile,
    can_delete_profile = EXCLUDED.can_delete_profile,
    can_change_profile_proxy = EXCLUDED.can_change_profile_proxy,
    can_manage_folders = EXCLUDED.can_manage_folders,
    can_manage_proxies = EXCLUDED.can_manage_proxies,
    can_manage_bookmarks = EXCLUDED.can_manage_bookmarks,
    updated_by = auth.uid(), updated_at = now();
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id, meta)
  VALUES (_team_id, auth.uid(), 'member.permissions_changed', 'member', _user_id,
    jsonb_build_object('create', _create, 'edit', _edit, 'delete', _delete, 'proxy', _proxy,
      'folders', _folders, 'proxies', _proxies, 'bookmarks', _bookmarks));
  RETURN true;
END $$;