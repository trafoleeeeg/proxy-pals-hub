
CREATE TABLE IF NOT EXISTS public.member_permissions (
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  can_create_profile boolean NOT NULL DEFAULT false,
  can_edit_profile boolean NOT NULL DEFAULT false,
  can_delete_profile boolean NOT NULL DEFAULT false,
  can_change_profile_proxy boolean NOT NULL DEFAULT false,
  can_manage_folders boolean NOT NULL DEFAULT false,
  can_manage_proxies boolean NOT NULL DEFAULT false,
  can_manage_bookmarks boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

GRANT SELECT ON public.member_permissions TO authenticated;
GRANT ALL ON public.member_permissions TO service_role;

ALTER TABLE public.member_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_permissions team read" ON public.member_permissions;
CREATE POLICY "member_permissions team read" ON public.member_permissions
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.team_members m WHERE m.team_id = member_permissions.team_id AND m.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.teams t WHERE t.id = member_permissions.team_id AND t.owner_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION private.has_permission(_user_id uuid, _team_id uuid, _perm text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
declare
  is_owner boolean;
  flag boolean;
begin
  select exists(select 1 from public.teams where id = _team_id and owner_id = _user_id) into is_owner;
  if is_owner then return true; end if;
  if _perm = 'profile.create' then
    select can_create_profile into flag from public.member_permissions where team_id = _team_id and user_id = _user_id;
  elsif _perm = 'profile.edit' then
    select can_edit_profile into flag from public.member_permissions where team_id = _team_id and user_id = _user_id;
  elsif _perm = 'profile.delete' then
    select can_delete_profile into flag from public.member_permissions where team_id = _team_id and user_id = _user_id;
  elsif _perm = 'profile.proxy' then
    select can_change_profile_proxy into flag from public.member_permissions where team_id = _team_id and user_id = _user_id;
  elsif _perm = 'folder.manage' then
    select can_manage_folders into flag from public.member_permissions where team_id = _team_id and user_id = _user_id;
  elsif _perm = 'proxy.manage' then
    select can_manage_proxies into flag from public.member_permissions where team_id = _team_id and user_id = _user_id;
  elsif _perm = 'bookmarks.manage' then
    select can_manage_bookmarks into flag from public.member_permissions where team_id = _team_id and user_id = _user_id;
  else
    flag := false;
  end if;
  return coalesce(flag, false);
end
$$;

REVOKE ALL ON FUNCTION private.has_permission(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION private.has_permission(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_member_permissions(
  _team_id uuid, _user_id uuid,
  _create boolean, _edit boolean, _delete boolean, _proxy boolean,
  _folders boolean, _proxies boolean, _bookmarks boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
begin
  if auth.uid() is null or not exists(select 1 from public.teams where id = _team_id and owner_id = auth.uid()) then
    raise exception 'Только владелец команды может менять права' using errcode = '42501';
  end if;
  if exists(select 1 from public.teams where id = _team_id and owner_id = _user_id) then
    raise exception 'Права владельца изменить нельзя' using errcode = '42501';
  end if;
  perform 1 from public.team_members where team_id = _team_id and user_id = _user_id;
  if not found then raise exception 'Пользователь не состоит в команде' using errcode = '42501'; end if;
  insert into public.member_permissions(team_id, user_id, can_create_profile, can_edit_profile, can_delete_profile,
    can_change_profile_proxy, can_manage_folders, can_manage_proxies, can_manage_bookmarks, updated_by, updated_at)
  values (_team_id, _user_id, _create, _edit, _delete, _proxy, _folders, _proxies, _bookmarks, auth.uid(), now())
  on conflict (team_id, user_id) do update set
    can_create_profile = excluded.can_create_profile,
    can_edit_profile = excluded.can_edit_profile,
    can_delete_profile = excluded.can_delete_profile,
    can_change_profile_proxy = excluded.can_change_profile_proxy,
    can_manage_folders = excluded.can_manage_folders,
    can_manage_proxies = excluded.can_manage_proxies,
    can_manage_bookmarks = excluded.can_manage_bookmarks,
    updated_by = auth.uid(),
    updated_at = now();
  insert into public.audit_log(team_id, user_id, action, target_type, target_id, meta)
  values (_team_id, auth.uid(), 'member.permissions_changed', 'member', _user_id,
    jsonb_build_object('create', _create, 'edit', _edit, 'delete', _delete, 'proxy', _proxy,
      'folders', _folders, 'proxies', _proxies, 'bookmarks', _bookmarks));
  return true;
end
$$;

REVOKE ALL ON FUNCTION public.set_member_permissions(uuid,uuid,boolean,boolean,boolean,boolean,boolean,boolean,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_member_permissions(uuid,uuid,boolean,boolean,boolean,boolean,boolean,boolean,boolean) TO authenticated;
