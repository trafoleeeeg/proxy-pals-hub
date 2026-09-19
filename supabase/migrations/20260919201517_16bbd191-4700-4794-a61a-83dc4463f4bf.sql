
-- 1. Владелец и администратор всегда имеют все права.
CREATE OR REPLACE FUNCTION private.has_permission(_user_id uuid, _team_id uuid, _perm text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
declare flag boolean;
begin
  if private.can_manage(_user_id, _team_id) then return true; end if;
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
  else flag := false;
  end if;
  return coalesce(flag, false);
end
$$;

-- 2. Доступ к папке.
CREATE OR REPLACE FUNCTION private.can_use_folder(_user_id uuid, _team_id uuid, _folder text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  select private.can_manage(_user_id, _team_id)
    or exists (select 1 from public.folder_access fa
      where fa.team_id = _team_id and fa.folder = _folder and fa.user_id = _user_id)
$$;

REVOKE ALL ON FUNCTION private.can_use_folder(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION private.can_use_folder(uuid, uuid, text) TO authenticated, service_role;

-- 3. Записи сотрудников в рамках выданных прав и доступных папок.
DROP POLICY IF EXISTS "bp member insert" ON public.browser_profiles;
CREATE POLICY "bp member insert" ON public.browser_profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    private.has_permission(auth.uid(), team_id, 'profile.create')
    AND private.can_use_folder(auth.uid(), team_id, folder)
  );

DROP POLICY IF EXISTS "bp member update" ON public.browser_profiles;
CREATE POLICY "bp member update" ON public.browser_profiles
  FOR UPDATE TO authenticated
  USING (
    private.has_permission(auth.uid(), team_id, 'profile.edit')
    AND private.can_use_folder(auth.uid(), team_id, folder)
  )
  WITH CHECK (
    private.has_permission(auth.uid(), team_id, 'profile.edit')
    AND private.can_use_folder(auth.uid(), team_id, folder)
  );

DROP POLICY IF EXISTS "bp member delete" ON public.browser_profiles;
CREATE POLICY "bp member delete" ON public.browser_profiles
  FOR DELETE TO authenticated
  USING (
    private.has_permission(auth.uid(), team_id, 'profile.delete')
    AND private.can_use_folder(auth.uid(), team_id, folder)
  );

-- 4. Массовые операции с учётом прав и доступных папок.
CREATE OR REPLACE FUNCTION public.bulk_mutate_profiles(_team_id uuid, _profile_ids uuid[], _operation text, _changes jsonb DEFAULT '{}'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare affected integer; needed text;
begin
  if _operation = 'delete' then needed := 'profile.delete';
  elsif _operation = 'update' then needed := 'profile.edit';
  else raise exception 'Invalid bulk operation' using errcode = '22023';
  end if;
  if auth.uid() is null or not private.has_permission(auth.uid(), _team_id, needed) then
    raise exception 'Недостаточно прав для изменения профилей' using errcode = '42501';
  end if;
  if cardinality(_profile_ids) is null or cardinality(_profile_ids) not between 1 and 200
    or cardinality(_profile_ids) <> (select count(distinct i) from unnest(_profile_ids) i) then
    raise exception 'Invalid profile selection' using errcode = '22023';
  end if;
  perform 1 from public.browser_profiles where team_id = _team_id and id = any(_profile_ids) order by id for update;
  get diagnostics affected = row_count;
  if affected <> cardinality(_profile_ids) then raise exception 'Profile selection contains unavailable or cross-team profiles' using errcode = '42501'; end if;
  if exists (select 1 from public.browser_profiles p where p.id = any(_profile_ids)
      and not private.can_use_folder(auth.uid(), _team_id, p.folder)) then
    raise exception 'В выборе есть профили из недоступных вам папок' using errcode = '42501';
  end if;
  if exists (select 1 from public.profile_locks where profile_id = any(_profile_ids) and expires_at > clock_timestamp()) then
    raise exception 'Close the selected profiles first' using errcode = '55P03';
  end if;
  if _operation = 'delete' then
    delete from public.browser_profiles where team_id = _team_id and id = any(_profile_ids);
  else
    if _changes is null or jsonb_typeof(_changes) <> 'object' or _changes = '{}'::jsonb
      or exists (select 1 from jsonb_object_keys(_changes) k where k not in ('folder', 'tags', 'notes', 'proxyId', 'fingerprint'))
      or (_changes ? 'fingerprint' and jsonb_typeof(_changes->'fingerprint') <> 'object') then
      raise exception 'Invalid profile changes' using errcode = '22023';
    end if;
    if _changes ? 'proxyId' and not private.has_permission(auth.uid(), _team_id, 'profile.proxy') then
      raise exception 'Недостаточно прав для смены прокси профиля' using errcode = '42501';
    end if;
    if _changes ? 'folder' and not private.can_use_folder(auth.uid(), _team_id, _changes->>'folder') then
      raise exception 'Целевая папка вам недоступна' using errcode = '42501';
    end if;
    update public.browser_profiles set
      folder = case when _changes ? 'folder' then _changes->>'folder' else folder end,
      tags = case when _changes ? 'tags' then array(select jsonb_array_elements_text(_changes->'tags')) else tags end,
      notes = case when _changes ? 'notes' then _changes->>'notes' else notes end,
      proxy_id = case when _changes ? 'proxyId' then (_changes->>'proxyId')::uuid else proxy_id end,
      fingerprint = case when _changes ? 'fingerprint' then fingerprint || (_changes->'fingerprint') else fingerprint end
      where team_id = _team_id and id = any(_profile_ids);
  end if;
  insert into public.audit_log(team_id, user_id, action, target_type, meta)
    values (_team_id, auth.uid(), 'profiles.bulk_' || _operation, 'profile', jsonb_build_object('count', affected));
  return affected;
end $function$;

-- 5. Передача только в папку.
CREATE OR REPLACE FUNCTION public.transfer_profiles(_team_id uuid, _profile_ids uuid[], _folder text DEFAULT NULL::text, _user_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare affected integer;
begin
  if auth.uid() is null or not private.has_permission(auth.uid(), _team_id, 'profile.edit') then
    raise exception 'Недостаточно прав для передачи профилей' using errcode = '42501';
  end if;
  if _user_id is not null then
    raise exception 'Профили передаются только в папку' using errcode = '22023';
  end if;
  if _folder is null or length(_folder) not between 1 and 200 then
    raise exception 'Укажите папку назначения' using errcode = '22023';
  end if;
  if cardinality(_profile_ids) is null or cardinality(_profile_ids) not between 1 and 200
    or cardinality(_profile_ids) <> (select count(distinct i) from unnest(_profile_ids) i) then
    raise exception 'Некорректный выбор профилей' using errcode = '22023';
  end if;
  if not private.can_use_folder(auth.uid(), _team_id, _folder) then
    raise exception 'Целевая папка вам недоступна' using errcode = '42501';
  end if;
  perform 1 from public.browser_profiles where team_id = _team_id and id = any(_profile_ids) order by id for update;
  get diagnostics affected = row_count;
  if affected <> cardinality(_profile_ids) then
    raise exception 'В выборе есть недоступные профили' using errcode = '42501';
  end if;
  if exists (select 1 from public.browser_profiles p where p.id = any(_profile_ids)
      and not private.can_use_folder(auth.uid(), _team_id, p.folder)) then
    raise exception 'В выборе есть профили из недоступных вам папок' using errcode = '42501';
  end if;
  if exists (select 1 from public.profile_locks where profile_id = any(_profile_ids) and expires_at > clock_timestamp()) then
    raise exception 'Сначала закройте выбранные профили' using errcode = '55P03';
  end if;
  update public.browser_profiles set folder = _folder
    where team_id = _team_id and id = any(_profile_ids);
  insert into public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    values (_team_id, auth.uid(), 'profiles.transferred', 'profile', null,
      jsonb_build_object('count', affected, 'folder', _folder));
  return affected;
end $function$;

-- 6. Настройки браузера доступны всем, у кого есть доступ к профилю.
CREATE OR REPLACE FUNCTION public.save_profile_browser_settings(_profile_id uuid, _bookmarks jsonb, _bookmark_bar_visible boolean, _zoom_level numeric, _extensions jsonb, _expected_revision bigint DEFAULT NULL::bigint, _active_proxy_id uuid DEFAULT NULL::uuid, _proxy_failover boolean DEFAULT false)
 RETURNS profile_browser_settings
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '5s'
 SET statement_timeout TO '15s'
AS $function$
declare current_row public.profile_browser_settings; saved_row public.profile_browser_settings;
begin
  if auth.uid() is null or not private.can_access_profile(auth.uid(), _profile_id) then
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
end $function$;
