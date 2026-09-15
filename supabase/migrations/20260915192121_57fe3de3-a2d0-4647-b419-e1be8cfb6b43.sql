do $$ begin
  lock table public.profile_locks in access exclusive mode;
  if exists (select 1 from public.profile_locks) then
    raise exception 'Есть открытые профили (активные блокировки). Применение миграции остановлено.' using errcode = '55P03';
  end if;
end $$;
-- Apply through the normal deployment process. Never run against production from an agent.
-- Ownership is anchored in teams.owner_id, not in a mutable membership role.
create or replace function private.has_role(_user_id uuid, _team_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when _role = 'owner' then exists (
    select 1 from public.teams where id = _team_id and owner_id = _user_id
  ) else exists (
    select 1 from public.team_members m join public.teams t on t.id = m.team_id
    where m.team_id = _team_id and m.user_id = _user_id and m.role = _role and t.owner_id <> _user_id
  ) end
$$;
create or replace function private.is_team_member(_user_id uuid, _team_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(_user_id, _team_id, 'owner') or exists (
    select 1 from public.team_members where user_id = _user_id and team_id = _team_id
  )
$$;
create or replace function private.has_profile_access(_user uuid, _profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profile_access a join public.browser_profiles p on p.id = a.profile_id
    join public.team_members m on m.team_id = p.team_id and m.user_id = a.user_id
    where a.profile_id = _profile and a.user_id = _user
  )
$$;
create or replace function private.can_access_profile(_user_id uuid, _profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.browser_profiles p where p.id = _profile_id and (
    private.has_role(_user_id, p.team_id, 'owner') or private.has_profile_access(_user_id, p.id)
  ))
$$;

alter table public.browser_profiles add column cookies_updated_at timestamptz not null default now();
update public.browser_profiles set cookies_updated_at = updated_at;
alter table public.browser_profiles drop constraint browser_profiles_proxy_id_fkey;
alter table public.browser_profiles add constraint browser_profiles_proxy_id_fkey
  foreign key (proxy_id) references public.proxies(id) on delete restrict;
alter table public.profile_locks add column lock_token uuid not null default gen_random_uuid();
alter table public.profile_locks add column device_id text not null default 'legacy';
-- Legacy clients cannot keep writing after the token-enforcing migration.
delete from public.profile_locks;

drop policy "bp member update notes" on public.browser_profiles;
revoke update on public.browser_profiles from authenticated;
grant update (name, folder, tags, notes, proxy_id, fingerprint) on public.browser_profiles to authenticated;
revoke insert, update, delete, select on public.profile_locks from authenticated;
grant select (profile_id, user_id, device_label, acquired_at, heartbeat_at, expires_at) on public.profile_locks to authenticated;
drop policy "locks insert" on public.profile_locks;
drop policy "locks update" on public.profile_locks;
drop policy "locks delete" on public.profile_locks;

create or replace function private.guard_profile_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.team_id is distinct from old.team_id or new.created_by is distinct from old.created_by) then
    raise exception 'Profile team and creator are immutable' using errcode = '42501';
  end if;
  if new.proxy_id is not null then
    perform 1 from public.proxies where id = new.proxy_id and team_id = new.team_id for share;
    if not found then raise exception 'Proxy belongs to another team or is unavailable' using errcode = '23503'; end if;
  end if;
  if tg_op = 'UPDATE' and new.cookies_enc is distinct from old.cookies_enc then
    new.cookies_updated_at := clock_timestamp();
  end if;
  return new;
end
$$;
create trigger profile_write_guard before insert or update on public.browser_profiles
  for each row execute function private.guard_profile_write();

create or replace function private.guard_proxy_team()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.team_id is distinct from old.team_id then
    raise exception 'Proxy team is immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger proxy_team_guard before update on public.proxies for each row execute function private.guard_proxy_team();

create or replace function private.guard_team_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'Team owner is immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger team_identity_guard before update on public.teams for each row execute function private.guard_team_identity();

create or replace function private.guard_profile_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.team_members m join public.browser_profiles p on p.team_id = m.team_id
    where p.id = new.profile_id and m.user_id = new.user_id for key share of m;
  if not found then raise exception 'Profile access requires membership in the same team' using errcode = '42501'; end if;
  return new;
end
$$;
create trigger profile_access_guard before insert or update on public.profile_access
  for each row execute function private.guard_profile_access();

create or replace function private.cleanup_member_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.profile_access a using public.browser_profiles p
    where a.profile_id = p.id and p.team_id = old.team_id and a.user_id = old.user_id;
  delete from public.profile_locks l using public.browser_profiles p
    where l.profile_id = p.id and p.team_id = old.team_id and l.user_id = old.user_id;
  return old;
end
$$;
create trigger member_access_cleanup after delete on public.team_members for each row execute function private.cleanup_member_access();

create or replace function private.owner_can_read_user(_viewer uuid, _user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members m join public.teams t on t.id = m.team_id
    where m.user_id = _user and t.owner_id = _viewer)
$$;
revoke all on function private.owner_can_read_user(uuid,uuid) from public, anon;
grant execute on function private.owner_can_read_user(uuid,uuid) to authenticated;
create policy "owner reads team people" on public.profiles for select to authenticated
  using (private.owner_can_read_user(auth.uid(), id));

-- All session operations lock the profile row first. No read-then-upsert window,
-- and cookies and lease release are committed together.
create function public.acquire_profile_lease(_profile_id uuid, _device_id text, _device_label text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.browser_profiles; l public.profile_locks; expiry timestamptz;
begin
  if auth.uid() is null or not private.can_access_profile(auth.uid(), _profile_id) then
    raise exception 'No profile access' using errcode = '42501';
  end if;
  if _device_id is null or length(_device_id) not between 1 and 200 or length(_device_label) > 200 then
    raise exception 'Invalid device identity' using errcode = '22023';
  end if;
  select * into p from public.browser_profiles where id = _profile_id for update;
  if not found then raise exception 'Profile unavailable' using errcode = '42501'; end if;
  select * into l from public.profile_locks where profile_id = _profile_id;
  if found and l.expires_at > clock_timestamp() then
    raise exception 'Profile already running on a device' using errcode = '55P03';
  end if;
  expiry := clock_timestamp() + interval '5 minutes';
  insert into public.profile_locks (profile_id, user_id, device_id, device_label, lock_token, acquired_at, heartbeat_at, expires_at)
    values (_profile_id, auth.uid(), _device_id, _device_label, gen_random_uuid(), clock_timestamp(), clock_timestamp(), expiry)
    on conflict (profile_id) do update set user_id = excluded.user_id, device_id = excluded.device_id,
      device_label = excluded.device_label, lock_token = excluded.lock_token, acquired_at = excluded.acquired_at,
      heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at returning * into l;
  return jsonb_build_object('lockToken', l.lock_token, 'expiresAt', expiry, 'cookiesUpdatedAt', p.cookies_updated_at);
end
$$;

create function public.mutate_profile_lease(_profile_id uuid, _lock_token uuid, _operation text, _cookies_enc text default null, _device_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.browser_profiles; l public.profile_locks; expiry timestamptz;
begin
  if auth.uid() is null or not private.can_access_profile(auth.uid(), _profile_id) then
    raise exception 'No profile access' using errcode = '42501';
  end if;
  if _operation is null or _operation not in ('save', 'heartbeat', 'close') then
    raise exception 'Invalid lease operation' using errcode = '22023';
  end if;
  if (_operation = 'save' and _cookies_enc is null) or octet_length(_cookies_enc) > 7000000 then
    raise exception 'Invalid encrypted cookies' using errcode = '22023';
  end if;
  select * into p from public.browser_profiles where id = _profile_id for update;
  select * into l from public.profile_locks where profile_id = _profile_id;
  if not found or _lock_token is null or l.lock_token <> _lock_token or l.user_id <> auth.uid()
     or l.expires_at <= clock_timestamp() or (_device_id is not null and l.device_id <> _device_id) then
    raise exception 'Session lease lost; reopen the profile' using errcode = '42501';
  end if;
  if _operation in ('save', 'close') and _cookies_enc is not null then
    update public.browser_profiles set cookies_enc = _cookies_enc where id = _profile_id returning * into p;
  end if;
  expiry := clock_timestamp() + interval '5 minutes';
  if _operation = 'close' then
    delete from public.profile_locks where profile_id = _profile_id;
  else
    update public.profile_locks set heartbeat_at = clock_timestamp(), expires_at = expiry where profile_id = _profile_id;
  end if;
  return jsonb_build_object('expiresAt', expiry, 'cookiesUpdatedAt', p.cookies_updated_at);
end
$$;

create function public.force_profile_unlock(_profile_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare p public.browser_profiles;
begin
  select * into p from public.browser_profiles where id = _profile_id for update;
  if auth.uid() is null or not found or not private.has_role(auth.uid(), p.team_id, 'owner') then
    raise exception 'Only the team owner can unlock a profile' using errcode = '42501';
  end if;
  delete from public.profile_locks where profile_id = _profile_id;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id)
    values (p.team_id, auth.uid(), 'profile.force_unlocked', 'profile', p.id);
  return true;
end
$$;

create function public.import_profile_cookies(_profile_id uuid, _cookies_enc text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare p public.browser_profiles;
begin
  select * into p from public.browser_profiles where id = _profile_id for update;
  if auth.uid() is null or not found or not private.has_role(auth.uid(), p.team_id, 'owner') then
    raise exception 'Only the team owner can import cookies' using errcode = '42501';
  end if;
  if _cookies_enc is null or octet_length(_cookies_enc) not between 1 and 7000000 then
    raise exception 'Invalid encrypted cookies' using errcode = '22023';
  end if;
  if exists (select 1 from public.profile_locks where profile_id = _profile_id and expires_at > clock_timestamp()) then
    raise exception 'Close the profile before importing cookies' using errcode = '55P03';
  end if;
  update public.browser_profiles set cookies_enc = _cookies_enc where id = _profile_id returning * into p;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id)
    values (p.team_id, auth.uid(), 'profile.cookies_imported', 'profile', p.id);
  return p.cookies_updated_at;
end
$$;

create function public.bulk_mutate_profiles(_team_id uuid, _profile_ids uuid[], _operation text, _changes jsonb default '{}'::jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if auth.uid() is null or not private.has_role(auth.uid(), _team_id, 'owner') then
    raise exception 'Only the team owner can edit profiles' using errcode = '42501';
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
end
$$;

create function public.set_profiles_access(_team_id uuid, _profile_ids uuid[], _user_id uuid, _granted boolean)
returns integer language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if auth.uid() is null or not private.has_role(auth.uid(), _team_id, 'owner') then
    raise exception 'Only the team owner can assign profiles' using errcode = '42501';
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
end
$$;

create function public.remove_team_member(_team_id uuid, _user_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null or not private.has_role(auth.uid(), _team_id, 'owner')
    or private.has_role(_user_id, _team_id, 'owner') then
    raise exception 'Cannot remove this team member' using errcode = '42501';
  end if;
  delete from public.team_members where team_id = _team_id and user_id = _user_id;
  if not found then raise exception 'Team member not found' using errcode = '42501'; end if;
  insert into public.audit_log(team_id, user_id, action, target_type, target_id)
    values (_team_id, auth.uid(), 'member.removed', 'member', _user_id);
  return true;
end
$$;

create function public.accept_team_invite(_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare invitation public.team_invites; user_email text;
begin
  if auth.uid() is null or _token is null or _token !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'Invalid invitation' using errcode = '42501';
  end if;
  select lower(email) into user_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if user_email is null or user_email = '' then raise exception 'A verified email is required' using errcode = '42501'; end if;
  select * into invitation from public.team_invites where token = _token for update;
  if not found or invitation.accepted_at is not null or invitation.expires_at <= clock_timestamp()
    or lower(invitation.email) <> user_email or invitation.role <> 'member' then
    raise exception 'Invitation unavailable or issued for another email' using errcode = '42501';
  end if;
  insert into public.team_members(team_id, user_id, role)
    values (invitation.team_id, auth.uid(), 'member') on conflict (team_id,user_id) do nothing;
  update public.team_invites set accepted_at = clock_timestamp() where id = invitation.id;
  insert into public.audit_log(team_id, user_id, action, target_type)
    values (invitation.team_id, auth.uid(), 'member.joined', 'member');
  return invitation.team_id;
end
$$;

create function public.ensure_workspace()
returns uuid language plpgsql security definer set search_path = '' as $$
declare team_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  select t.id into team_id from public.teams t where t.owner_id = auth.uid()
    or exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = auth.uid())
    order by t.created_at, t.id limit 1;
  if team_id is null then
    insert into public.teams(owner_id, name) values (auth.uid(), 'Моя команда') returning id into team_id;
    insert into public.team_members(team_id, user_id, role) values (team_id, auth.uid(), 'owner');
  end if;
  return team_id;
end
$$;

revoke all on function public.acquire_profile_lease(uuid,text,text), public.mutate_profile_lease(uuid,uuid,text,text,text),
  public.force_profile_unlock(uuid), public.import_profile_cookies(uuid,text), public.bulk_mutate_profiles(uuid,uuid[],text,jsonb),
  public.set_profiles_access(uuid,uuid[],uuid,boolean), public.remove_team_member(uuid,uuid), public.accept_team_invite(text), public.ensure_workspace()
  from public, anon;
grant execute on function public.acquire_profile_lease(uuid,text,text), public.mutate_profile_lease(uuid,uuid,text,text,text),
  public.force_profile_unlock(uuid), public.import_profile_cookies(uuid,text), public.bulk_mutate_profiles(uuid,uuid[],text,jsonb),
  public.set_profiles_access(uuid,uuid[],uuid,boolean), public.remove_team_member(uuid,uuid), public.accept_team_invite(text), public.ensure_workspace()
  to authenticated;
revoke all on function private.guard_profile_write(), private.guard_proxy_team(), private.guard_team_identity(),
  private.guard_profile_access(), private.cleanup_member_access() from public, anon, authenticated;
revoke all on function private.has_profile_access(uuid,uuid), private.profile_team(uuid), private.has_role(uuid,uuid,public.app_role),
  private.is_team_member(uuid,uuid), private.can_access_profile(uuid,uuid) from public, anon;