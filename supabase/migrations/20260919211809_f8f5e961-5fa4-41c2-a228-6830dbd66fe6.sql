create table if not exists private.super_admins (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);

create or replace function private.is_superadmin(_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select _user_id is not null and exists (select 1 from private.super_admins s where s.user_id = _user_id)
$$;

create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_superadmin(auth.uid())
$$;
grant execute on function public.is_superadmin() to authenticated;

create or replace function private.has_role(_user_id uuid, _team_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when _role = 'owner' then (
    private.is_superadmin(_user_id)
    or exists (select 1 from public.teams where id = _team_id and owner_id = _user_id)
  ) else exists (
    select 1 from public.team_members m join public.teams t on t.id = m.team_id
    where m.team_id = _team_id and m.user_id = _user_id and m.role = _role and t.owner_id <> _user_id
  ) end
$$;

create or replace function public.set_member_permissions(_team_id uuid, _user_id uuid, _create boolean, _edit boolean, _delete boolean, _proxy boolean, _folders boolean, _proxies boolean, _bookmarks boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.has_role(auth.uid(), _team_id, 'owner'::public.app_role) then
    raise exception 'Только владелец команды может менять права' using errcode = '42501';
  end if;
  if exists(select 1 from public.teams where id = _team_id and owner_id = _user_id)
     or private.is_superadmin(_user_id) then
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

insert into private.super_admins(user_id)
select id from auth.users where lower(email) = 'mafiatrafa@umbra.app'
on conflict (user_id) do nothing;