-- ============ enums ============
create type public.app_role as enum ('owner', 'member');
create type public.proxy_protocol as enum ('http', 'https', 'socks5');

-- ============ profiles (users) ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

-- ============ teams ============
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Моя команда',
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.teams to authenticated;
grant all on public.teams to service_role;
alter table public.teams enable row level security;

-- ============ team members ============
create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);
grant select, insert, update, delete on public.team_members to authenticated;
grant all on public.team_members to service_role;
alter table public.team_members enable row level security;

-- ============ security definer helpers ============
create or replace function public.has_role(_user_id uuid, _team_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where user_id = _user_id and team_id = _team_id and role = _role
  )
$$;

create or replace function public.is_team_member(_user_id uuid, _team_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where user_id = _user_id and team_id = _team_id
  )
$$;

create or replace function public.my_team_ids(_user_id uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select team_id from public.team_members where user_id = _user_id
$$;

-- ============ invites ============
create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  email text not null,
  role public.app_role not null default 'member',
  token text not null unique,
  invited_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.team_invites to authenticated;
grant all on public.team_invites to service_role;
alter table public.team_invites enable row level security;

-- ============ proxies ============
create table public.proxies (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  label text not null default '',
  protocol public.proxy_protocol not null default 'http',
  host text not null,
  port integer not null,
  username text,
  password_enc text,
  country text,
  city text,
  last_checked_at timestamptz,
  last_check_ok boolean,
  last_check_ip text,
  last_check_latency_ms integer,
  last_check_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.proxies to authenticated;
grant all on public.proxies to service_role;
alter table public.proxies enable row level security;

-- ============ browser profiles ============
create table public.browser_profiles (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  folder text not null default '',
  tags text[] not null default '{}',
  notes text not null default '',
  proxy_id uuid references public.proxies(id) on delete set null,
  fingerprint jsonb not null default '{}'::jsonb,
  cookies_enc text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.browser_profiles to authenticated;
grant all on public.browser_profiles to service_role;
alter table public.browser_profiles enable row level security;
create index browser_profiles_team_idx on public.browser_profiles(team_id);

-- ============ profile access ============
create table public.profile_access (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.browser_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (profile_id, user_id)
);
grant select, insert, update, delete on public.profile_access to authenticated;
grant all on public.profile_access to service_role;
alter table public.profile_access enable row level security;

create or replace function public.can_access_profile(_user_id uuid, _profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.browser_profiles bp
    where bp.id = _profile_id
      and (
        public.has_role(_user_id, bp.team_id, 'owner')
        or exists (
          select 1 from public.profile_access pa
          where pa.profile_id = bp.id and pa.user_id = _user_id
        )
      )
  )
$$;

-- ============ profile locks ============
create table public.profile_locks (
  profile_id uuid primary key references public.browser_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_label text,
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes'
);
grant select, insert, update, delete on public.profile_locks to authenticated;
grant all on public.profile_locks to service_role;
alter table public.profile_locks enable row level security;

-- ============ audit log ============
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id uuid,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant select, insert on public.audit_log to authenticated;
grant all on public.audit_log to service_role;
alter table public.audit_log enable row level security;
create index audit_log_team_idx on public.audit_log(team_id, created_at desc);

-- ============ policies ============
create policy "own profile read" on public.profiles for select to authenticated using (id = auth.uid());
create policy "own profile insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "own profile update" on public.profiles for update to authenticated using (id = auth.uid());

create policy "teams read" on public.teams for select to authenticated using (public.is_team_member(auth.uid(), id));
create policy "teams insert" on public.teams for insert to authenticated with check (owner_id = auth.uid());
create policy "teams update" on public.teams for update to authenticated using (public.has_role(auth.uid(), id, 'owner'));
create policy "teams delete" on public.teams for delete to authenticated using (owner_id = auth.uid());

create policy "members read" on public.team_members for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), team_id, 'owner'));
create policy "members insert" on public.team_members for insert to authenticated
  with check (
    user_id = auth.uid() and exists (select 1 from public.teams t where t.id = team_id and t.owner_id = auth.uid())
  );
create policy "members delete" on public.team_members for delete to authenticated
  using (public.has_role(auth.uid(), team_id, 'owner') and user_id <> auth.uid());

create policy "invites owner all" on public.team_invites for all to authenticated
  using (public.has_role(auth.uid(), team_id, 'owner'))
  with check (public.has_role(auth.uid(), team_id, 'owner'));

create policy "proxies owner all" on public.proxies for all to authenticated
  using (public.has_role(auth.uid(), team_id, 'owner'))
  with check (public.has_role(auth.uid(), team_id, 'owner'));
create policy "proxies member read" on public.proxies for select to authenticated
  using (
    public.is_team_member(auth.uid(), team_id)
    and exists (
      select 1 from public.browser_profiles bp
      join public.profile_access pa on pa.profile_id = bp.id
      where bp.proxy_id = proxies.id and pa.user_id = auth.uid()
    )
  );

create policy "bp owner all" on public.browser_profiles for all to authenticated
  using (public.has_role(auth.uid(), team_id, 'owner'))
  with check (public.has_role(auth.uid(), team_id, 'owner'));
create policy "bp member read" on public.browser_profiles for select to authenticated
  using (exists (select 1 from public.profile_access pa where pa.profile_id = browser_profiles.id and pa.user_id = auth.uid()));
create policy "bp member update notes" on public.browser_profiles for update to authenticated
  using (exists (select 1 from public.profile_access pa where pa.profile_id = browser_profiles.id and pa.user_id = auth.uid()))
  with check (exists (select 1 from public.profile_access pa where pa.profile_id = browser_profiles.id and pa.user_id = auth.uid()));

create policy "access owner all" on public.profile_access for all to authenticated
  using (exists (select 1 from public.browser_profiles bp where bp.id = profile_id and public.has_role(auth.uid(), bp.team_id, 'owner')))
  with check (exists (select 1 from public.browser_profiles bp where bp.id = profile_id and public.has_role(auth.uid(), bp.team_id, 'owner')));
create policy "access self read" on public.profile_access for select to authenticated using (user_id = auth.uid());

create policy "locks read" on public.profile_locks for select to authenticated
  using (public.can_access_profile(auth.uid(), profile_id));
create policy "locks insert" on public.profile_locks for insert to authenticated
  with check (user_id = auth.uid() and public.can_access_profile(auth.uid(), profile_id));
create policy "locks update" on public.profile_locks for update to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.browser_profiles bp where bp.id = profile_id and public.has_role(auth.uid(), bp.team_id, 'owner')));
create policy "locks delete" on public.profile_locks for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.browser_profiles bp where bp.id = profile_id and public.has_role(auth.uid(), bp.team_id, 'owner')));

create policy "audit owner read" on public.audit_log for select to authenticated
  using (public.has_role(auth.uid(), team_id, 'owner'));
create policy "audit insert" on public.audit_log for insert to authenticated
  with check (user_id = auth.uid() and public.is_team_member(auth.uid(), team_id));

-- ============ triggers ============
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end; $$;

create trigger proxies_updated before update on public.proxies
  for each row execute function public.set_updated_at();
create trigger bp_updated before update on public.browser_profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();