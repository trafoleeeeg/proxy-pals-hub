alter table public.team_members add column if not exists scope text not null default 'member';
alter table public.team_members drop constraint if exists team_members_scope_check;
alter table public.team_members add constraint team_members_scope_check check (scope in ('member','manager'));

create or replace function private.can_manage(_user uuid, _team uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select private.has_role(_user, _team, 'owner'::public.app_role)
    or exists (select 1 from public.team_members m
      where m.team_id = _team and m.user_id = _user and m.scope = 'manager')
$$;
grant execute on function private.can_manage(uuid, uuid) to authenticated, service_role;

drop policy if exists "bp owner all" on public.browser_profiles;
create policy "bp manager all" on public.browser_profiles for all to authenticated
  using (private.can_manage(auth.uid(), team_id)) with check (private.can_manage(auth.uid(), team_id));

drop policy if exists "bp member read" on public.browser_profiles;
create policy "bp member read" on public.browser_profiles for select to authenticated
  using (private.can_manage(auth.uid(), team_id) or private.has_profile_access(auth.uid(), id));

drop policy if exists "proxies owner all" on public.proxies;
create policy "proxies manager all" on public.proxies for all to authenticated
  using (private.can_manage(auth.uid(), team_id)) with check (private.can_manage(auth.uid(), team_id));

drop policy if exists "status owner insert" on public.profile_statuses;
drop policy if exists "status owner update" on public.profile_statuses;
drop policy if exists "status owner delete" on public.profile_statuses;
create policy "status manager insert" on public.profile_statuses for insert to authenticated
  with check (private.can_manage(auth.uid(), team_id));
create policy "status manager update" on public.profile_statuses for update to authenticated
  using (private.can_manage(auth.uid(), team_id)) with check (private.can_manage(auth.uid(), team_id));
create policy "status manager delete" on public.profile_statuses for delete to authenticated
  using (private.can_manage(auth.uid(), team_id));

drop policy if exists "field owner insert" on public.profile_field_definitions;
drop policy if exists "field owner update" on public.profile_field_definitions;
drop policy if exists "field owner delete" on public.profile_field_definitions;
create policy "field manager insert" on public.profile_field_definitions for insert to authenticated
  with check (private.can_manage(auth.uid(), team_id));
create policy "field manager update" on public.profile_field_definitions for update to authenticated
  using (private.can_manage(auth.uid(), team_id)) with check (private.can_manage(auth.uid(), team_id));
create policy "field manager delete" on public.profile_field_definitions for delete to authenticated
  using (private.can_manage(auth.uid(), team_id));

drop policy if exists "access owner all" on public.profile_access;
create policy "access manager all" on public.profile_access for all to authenticated
  using (private.can_manage(auth.uid(), private.profile_team(profile_id)))
  with check (private.can_manage(auth.uid(), private.profile_team(profile_id)));

drop policy if exists "browser settings owner insert" on public.profile_browser_settings;
drop policy if exists "browser settings owner update" on public.profile_browser_settings;
drop policy if exists "browser settings owner delete" on public.profile_browser_settings;
create policy "browser settings manager insert" on public.profile_browser_settings for insert to authenticated
  with check (private.can_manage(auth.uid(), private.profile_team(profile_id)));
create policy "browser settings manager update" on public.profile_browser_settings for update to authenticated
  using (private.can_manage(auth.uid(), private.profile_team(profile_id)))
  with check (private.can_manage(auth.uid(), private.profile_team(profile_id)));
create policy "browser settings manager delete" on public.profile_browser_settings for delete to authenticated
  using (private.can_manage(auth.uid(), private.profile_team(profile_id)));

drop policy if exists "audit owner read" on public.audit_log;
create policy "audit manager read" on public.audit_log for select to authenticated
  using (private.can_manage(auth.uid(), team_id));

create or replace function public.set_member_scope(_team_id uuid, _user_id uuid, _scope text)
returns boolean language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null or not private.has_role(auth.uid(), _team_id, 'owner'::public.app_role) then
    raise exception 'Только владелец команды меняет уровень доступа' using errcode = '42501';
  end if;
  if _scope is null or _scope not in ('member','manager') then
    raise exception 'Некорректный уровень доступа' using errcode = '22023';
  end if;
  if private.has_role(_user_id, _team_id, 'owner'::public.app_role) then
    raise exception 'Уровень доступа владельца изменить нельзя' using errcode = '42501';
  end if;
  update public.team_members set scope = _scope where team_id = _team_id and user_id = _user_id;
  if not found then raise exception 'Участник команды не найден' using errcode = '42501'; end if;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    values (_team_id, auth.uid(), 'member.scope_changed', 'member', _user_id, jsonb_build_object('scope', _scope));
  return true;
end $$;
grant execute on function public.set_member_scope(uuid, uuid, text) to authenticated;

create or replace function public.bulk_mutate_profiles(_team_id uuid, _profile_ids uuid[], _operation text, _changes jsonb default '{}'::jsonb)
returns integer language plpgsql set search_path to '' as $$
declare affected integer;
begin
  if auth.uid() is null or not private.can_manage(auth.uid(), _team_id) then
    raise exception 'Недостаточно прав для изменения профилей' using errcode = '42501';
  end if;
  if cardinality(_profile_ids) is null or cardinality(_profile_ids) not between 1 and 200
    or cardinality(_profile_ids) <> (select count(distinct i) from unnest(_profile_ids) i) then
    raise exception 'Invalid profile selection' using errcode = '22023';
  end if;
  perform 1 from public.browser_profiles where team_id = _team_id and id = any(_profile_ids) order by id for update;
  get diagnostics affected = row_count;
  if affected <> cardinality(_profile_ids) then raise exception 'Profile selection contains unavailable or cross-team profiles' using errcode = '42501'; end if;
  if exists (select 1 from public.profile_locks where profile_id = any(_profile_ids) and expires_at > clock_timestamp()) then
    raise exception 'Close the selected profiles first' using errcode = '55P03';
  end if;
  if _operation = 'delete' then
    delete from public.browser_profiles where team_id = _team_id and id = any(_profile_ids);
  elsif _operation = 'update' then
    if _changes is null or jsonb_typeof(_changes) <> 'object' or _changes = '{}'::jsonb
      or exists (select 1 from jsonb_object_keys(_changes) k where k not in ('folder', 'tags', 'notes', 'proxyId', 'fingerprint'))
      or (_changes ? 'fingerprint' and jsonb_typeof(_changes->'fingerprint') <> 'object') then
      raise exception 'Invalid profile changes' using errcode = '22023';
    end if;
    update public.browser_profiles set
      folder = case when _changes ? 'folder' then _changes->>'folder' else folder end,
      tags = case when _changes ? 'tags' then array(select jsonb_array_elements_text(_changes->'tags')) else tags end,
      notes = case when _changes ? 'notes' then _changes->>'notes' else notes end,
      proxy_id = case when _changes ? 'proxyId' then (_changes->>'proxyId')::uuid else proxy_id end,
      fingerprint = case when _changes ? 'fingerprint' then fingerprint || (_changes->'fingerprint') else fingerprint end
      where team_id = _team_id and id = any(_profile_ids);
  else raise exception 'Invalid bulk operation' using errcode = '22023';
  end if;
  insert into public.audit_log(team_id, user_id, action, target_type, meta)
    values (_team_id, auth.uid(), 'profiles.bulk_' || _operation, 'profile', jsonb_build_object('count', affected));
  return affected;
end $$;

create or replace function public.force_profile_unlock(_profile_id uuid)
returns boolean language plpgsql security definer set search_path to '' as $$
declare p public.browser_profiles;
begin
  select * into p from public.browser_profiles where id = _profile_id for update;
  if auth.uid() is null or not found or not private.can_manage(auth.uid(), p.team_id) then
    raise exception 'Недостаточно прав для разблокировки профиля' using errcode = '42501';
  end if;
  delete from public.profile_locks where profile_id = _profile_id;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id)
    values (p.team_id, auth.uid(), 'profile.force_unlocked', 'profile', p.id);
  return true;
end $$;

create or replace function public.set_profiles_access(_team_id uuid, _profile_ids uuid[], _user_id uuid, _granted boolean)
returns integer language plpgsql security definer set search_path to '' as $$
declare affected integer;
begin
  if auth.uid() is null or not private.can_manage(auth.uid(), _team_id) then
    raise exception 'Недостаточно прав для выдачи доступа' using errcode = '42501';
  end if;
  if cardinality(_profile_ids) is null or cardinality(_profile_ids) not between 1 and 200
    or cardinality(_profile_ids) <> (select count(distinct i) from unnest(_profile_ids) i) or _granted is null then
    raise exception 'Invalid access selection' using errcode = '22023';
  end if;
  perform 1 from public.team_members where team_id = _team_id and user_id = _user_id for key share;
  if not found then raise exception 'User is not a member of this team' using errcode = '42501'; end if;
  perform 1 from public.browser_profiles where team_id = _team_id and id = any(_profile_ids) order by id for update;
  get diagnostics affected = row_count;
  if affected <> cardinality(_profile_ids) then raise exception 'Invalid cross-team profile selection' using errcode = '42501'; end if;
  if _granted then
    insert into public.profile_access(profile_id, user_id, granted_by)
      select unnest(_profile_ids), _user_id, auth.uid() on conflict (profile_id,user_id) do nothing;
  else
    delete from public.profile_access where profile_id = any(_profile_ids) and user_id = _user_id;
  end if;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    values (_team_id, auth.uid(), 'profiles.access_changed', 'member', _user_id, jsonb_build_object('count', affected, 'granted', _granted));
  return affected;
end $$;

create or replace function public.save_profile_browser_settings(_profile_id uuid, _bookmarks jsonb, _bookmark_bar_visible boolean, _zoom_level numeric, _extensions jsonb, _expected_revision bigint default null, _active_proxy_id uuid default null, _proxy_failover boolean default false)
returns public.profile_browser_settings language plpgsql set search_path to '' as $$
declare current_row public.profile_browser_settings; saved_row public.profile_browser_settings;
begin
  if auth.uid() is null or not private.can_manage(auth.uid(), private.profile_team(_profile_id)) then
    raise exception 'Недостаточно прав для изменения настроек браузера' using errcode = '42501';
  end if;
  perform 1 from public.browser_profiles where id = _profile_id for key share;
  if not found then raise exception 'Profile unavailable' using errcode = '42501'; end if;
  select * into current_row from public.profile_browser_settings where profile_id = _profile_id for update;
  if found then
    if _expected_revision is not null and current_row.revision <> _expected_revision then
      raise exception 'Browser settings changed on another device' using errcode = '40001';
    end if;
    update public.profile_browser_settings set
      bookmarks = _bookmarks, bookmark_bar_visible = _bookmark_bar_visible, zoom_level = _zoom_level,
      extensions = _extensions, active_proxy_id = _active_proxy_id, proxy_failover = _proxy_failover,
      revision = current_row.revision + 1, updated_by = auth.uid()
    where profile_id = _profile_id returning * into saved_row;
  else
    if _expected_revision is not null and _expected_revision <> 0 then
      raise exception 'Browser settings changed on another device' using errcode = '40001';
    end if;
    insert into public.profile_browser_settings (profile_id, bookmarks, bookmark_bar_visible, zoom_level, extensions, active_proxy_id, proxy_failover, revision, updated_by)
    values (_profile_id, _bookmarks, _bookmark_bar_visible, _zoom_level, _extensions, _active_proxy_id, _proxy_failover, 1, auth.uid())
    returning * into saved_row;
  end if;
  return saved_row;
end $$;