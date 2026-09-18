-- Смена назначения в панели сбрасывает прежний выбор браузера.
create or replace function private.sync_assigned_profile_proxy()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  update public.profile_browser_settings
  set active_proxy_id = new.proxy_id, revision = revision + 1, updated_by = auth.uid()
  where profile_id = new.id;
  return new;
end $$;
create trigger sync_assigned_profile_proxy after update of proxy_id on public.browser_profiles
for each row when (old.proxy_id is distinct from new.proxy_id)
execute function private.sync_assigned_profile_proxy();

create table public.team_bookmark_defaults (
  team_id uuid primary key references public.teams(id) on delete cascade,
  bookmarks jsonb not null default '[]'::jsonb,
  bookmark_bar_visible boolean not null default true,
  revision bigint not null default 1,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.team_bookmark_defaults to authenticated;
grant all on public.team_bookmark_defaults to service_role;
alter table public.team_bookmark_defaults enable row level security;

create policy "team bookmark defaults read" on public.team_bookmark_defaults for select to authenticated
  using (
    private.can_manage(auth.uid(), team_id)
    or exists (select 1 from public.team_members member where member.team_id = team_bookmark_defaults.team_id and member.user_id = auth.uid())
  );
create policy "team bookmark defaults manage" on public.team_bookmark_defaults for all to authenticated
  using (private.can_manage(auth.uid(), team_id))
  with check (private.can_manage(auth.uid(), team_id));

create or replace function private.guard_team_bookmark_defaults()
returns trigger language plpgsql set search_path to '' as $$
begin
  if jsonb_typeof(new.bookmarks) <> 'array'
     or jsonb_array_length(new.bookmarks) > 64
     or octet_length(new.bookmarks::text) > 262144
     or exists (
       select 1 from jsonb_array_elements(new.bookmarks) item
       where jsonb_typeof(item) <> 'object'
          or exists (select 1 from jsonb_object_keys(item) key where key not in ('id', 'title', 'url', 'favicon'))
          or coalesce(item->>'id', '') !~ '^[0-9a-fA-F-]{36}$'
          or length(coalesce(item->>'title', '')) > 120
          or length(coalesce(item->>'url', '')) > 2048
          or coalesce(item->>'url', '') !~ '^https?://'
          or length(coalesce(item->>'favicon', '')) > 90000
     ) then
    raise exception 'Invalid team bookmark defaults' using errcode = '22023';
  end if;
  if new.revision < 1 then
    raise exception 'Invalid bookmark defaults revision' using errcode = '22023';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;

create trigger team_bookmark_defaults_guard
  before insert or update on public.team_bookmark_defaults
  for each row execute function private.guard_team_bookmark_defaults();

create or replace function public.get_team_bookmark_defaults(_team_id uuid)
returns jsonb language plpgsql security definer set search_path to '' stable as $$
declare saved public.team_bookmark_defaults;
begin
  if auth.uid() is null or not (
    private.can_manage(auth.uid(), _team_id)
    or exists (select 1 from public.team_members member where member.team_id = _team_id and member.user_id = auth.uid())
  ) then
    raise exception 'Нет доступа к настройкам закладок команды' using errcode = '42501';
  end if;
  select * into saved from public.team_bookmark_defaults where team_id = _team_id;
  if not found then
    return jsonb_build_object('teamId', _team_id, 'bookmarks', '[]'::jsonb, 'bookmarkBarVisible', true, 'revision', 0, 'updatedAt', null);
  end if;
  return jsonb_build_object(
    'teamId', saved.team_id, 'bookmarks', saved.bookmarks,
    'bookmarkBarVisible', saved.bookmark_bar_visible, 'revision', saved.revision,
    'updatedAt', saved.updated_at
  );
end $$;

create or replace function public.save_team_bookmark_defaults(_team_id uuid, _bookmarks jsonb, _bookmark_bar_visible boolean)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare saved public.team_bookmark_defaults;
begin
  if auth.uid() is null or not private.can_manage(auth.uid(), _team_id) then
    raise exception 'Недостаточно прав для изменения закладок команды' using errcode = '42501';
  end if;
  insert into public.team_bookmark_defaults(team_id, bookmarks, bookmark_bar_visible, revision, updated_by)
  values (_team_id, _bookmarks, _bookmark_bar_visible, 1, auth.uid())
  on conflict (team_id) do update set
    bookmarks = excluded.bookmarks,
    bookmark_bar_visible = excluded.bookmark_bar_visible,
    revision = public.team_bookmark_defaults.revision + 1,
    updated_by = auth.uid()
  returning * into saved;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id, meta)
  values (_team_id, auth.uid(), 'bookmarks.defaults_saved', 'team', _team_id, jsonb_build_object('count', jsonb_array_length(_bookmarks)));
  return jsonb_build_object(
    'teamId', saved.team_id, 'bookmarks', saved.bookmarks,
    'bookmarkBarVisible', saved.bookmark_bar_visible, 'revision', saved.revision,
    'updatedAt', saved.updated_at
  );
end $$;

revoke all on function public.get_team_bookmark_defaults(uuid) from public;
revoke all on function public.save_team_bookmark_defaults(uuid, jsonb, boolean) from public;
grant execute on function public.get_team_bookmark_defaults(uuid) to authenticated, service_role;
grant execute on function public.save_team_bookmark_defaults(uuid, jsonb, boolean) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_bookmark_defaults') then
    alter publication supabase_realtime add table public.team_bookmark_defaults;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'proxies') then
    alter publication supabase_realtime add table public.proxies;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'browser_profiles') then
    alter publication supabase_realtime add table public.browser_profiles;
  end if;
end $$;
