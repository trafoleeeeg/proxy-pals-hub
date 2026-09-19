CREATE TABLE public.folder_access (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  folder text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (team_id, folder, user_id)
);

GRANT SELECT ON public.folder_access TO authenticated;
GRANT ALL ON public.folder_access TO service_role;

ALTER TABLE public.folder_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY "folder access manager all" ON public.folder_access
  FOR ALL TO authenticated
  USING (private.can_manage(auth.uid(), team_id))
  WITH CHECK (private.can_manage(auth.uid(), team_id));

CREATE POLICY "folder access self read" ON public.folder_access
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX folder_access_team_folder_idx ON public.folder_access (team_id, folder);

CREATE OR REPLACE FUNCTION private.has_folder_profile_access(_user_id uuid, _profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  select exists (
    select 1 from public.browser_profiles p
    join public.folder_access fa
      on fa.team_id = p.team_id and fa.folder = p.folder and fa.user_id = _user_id
    where p.id = _profile_id
  )
$$;

CREATE OR REPLACE FUNCTION private.can_access_profile(_user_id uuid, _profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  select exists (select 1 from public.browser_profiles p where p.id = _profile_id and (
    private.has_role(_user_id, p.team_id, 'owner')
    or private.has_profile_access(_user_id, p.id)
    or private.has_folder_profile_access(_user_id, p.id)
  ))
$$;

DROP POLICY IF EXISTS "bp member read" ON public.browser_profiles;
CREATE POLICY "bp member read" ON public.browser_profiles
  FOR SELECT TO authenticated
  USING (
    private.can_manage(auth.uid(), team_id)
    or private.has_profile_access(auth.uid(), id)
    or exists (
      select 1 from public.folder_access fa
      where fa.team_id = browser_profiles.team_id
        and fa.folder = browser_profiles.folder
        and fa.user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.set_folder_access(_team_id uuid, _folder text, _user_id uuid, _granted boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
begin
  if auth.uid() is null or not private.can_manage(auth.uid(), _team_id) then
    raise exception 'Недостаточно прав для выдачи доступа к папке' using errcode = '42501';
  end if;
  if _folder is null or length(_folder) not between 1 and 200 or _granted is null then
    raise exception 'Некорректная папка' using errcode = '22023';
  end if;
  perform 1 from public.team_members where team_id = _team_id and user_id = _user_id;
  if not found then raise exception 'Пользователь не состоит в команде' using errcode = '42501'; end if;
  if _granted then
    insert into public.folder_access(team_id, folder, user_id, granted_by)
      values (_team_id, _folder, _user_id, auth.uid())
      on conflict (team_id, folder, user_id) do nothing;
  else
    delete from public.folder_access where team_id = _team_id and folder = _folder and user_id = _user_id;
  end if;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    values (_team_id, auth.uid(), 'folder.access_changed', 'member', _user_id,
      jsonb_build_object('folder', _folder, 'granted', _granted));
  return true;
end $$;

CREATE OR REPLACE FUNCTION public.transfer_profiles(_team_id uuid, _profile_ids uuid[], _folder text DEFAULT NULL::text, _user_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
declare affected integer;
begin
  if auth.uid() is null or not private.can_manage(auth.uid(), _team_id) then
    raise exception 'Недостаточно прав для передачи профилей' using errcode = '42501';
  end if;
  if cardinality(_profile_ids) is null or cardinality(_profile_ids) not between 1 and 200
    or cardinality(_profile_ids) <> (select count(distinct i) from unnest(_profile_ids) i) then
    raise exception 'Некорректный выбор профилей' using errcode = '22023';
  end if;
  if _folder is not null and length(_folder) not between 1 and 200 then
    raise exception 'Некорректная папка' using errcode = '22023';
  end if;
  if _folder is null and _user_id is null then
    raise exception 'Укажите папку или сотрудника' using errcode = '22023';
  end if;
  perform 1 from public.browser_profiles where team_id = _team_id and id = any(_profile_ids) order by id for update;
  get diagnostics affected = row_count;
  if affected <> cardinality(_profile_ids) then
    raise exception 'В выборе есть недоступные профили' using errcode = '42501';
  end if;
  if exists (select 1 from public.profile_locks where profile_id = any(_profile_ids) and expires_at > clock_timestamp()) then
    raise exception 'Сначала закройте выбранные профили' using errcode = '55P03';
  end if;
  if _user_id is not null then
    perform 1 from public.team_members where team_id = _team_id and user_id = _user_id;
    if not found then raise exception 'Пользователь не состоит в команде' using errcode = '42501'; end if;
    insert into public.profile_access(profile_id, user_id, granted_by)
      select unnest(_profile_ids), _user_id, auth.uid()
      on conflict (profile_id, user_id) do nothing;
  end if;
  if _folder is not null then
    update public.browser_profiles set folder = _folder
      where team_id = _team_id and id = any(_profile_ids);
  end if;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    values (_team_id, auth.uid(), 'profiles.transferred', 'profile', null,
      jsonb_build_object('count', affected, 'folder', _folder, 'userId', _user_id));
  return affected;
end $$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.folder_access;