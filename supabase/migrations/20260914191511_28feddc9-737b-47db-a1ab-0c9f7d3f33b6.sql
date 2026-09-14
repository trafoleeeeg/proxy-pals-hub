create schema if not exists private;
grant usage on schema private to authenticated, service_role;

create or replace function private.has_profile_access(_user uuid, _profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profile_access pa where pa.profile_id = _profile and pa.user_id = _user)
$$;

create or replace function private.profile_team(_profile uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select team_id from public.browser_profiles where id = _profile
$$;

grant execute on function private.has_profile_access(uuid, uuid) to authenticated, service_role;
grant execute on function private.profile_team(uuid) to authenticated, service_role;

drop policy if exists "bp member read" on public.browser_profiles;
create policy "bp member read" on public.browser_profiles for select to authenticated
using (public.has_role(auth.uid(), team_id, 'owner'::app_role) or private.has_profile_access(auth.uid(), id));

drop policy if exists "bp member update notes" on public.browser_profiles;
create policy "bp member update notes" on public.browser_profiles for update to authenticated
using (private.has_profile_access(auth.uid(), id))
with check (private.has_profile_access(auth.uid(), id));

drop policy if exists "access owner all" on public.profile_access;
create policy "access owner all" on public.profile_access for all to authenticated
using (public.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role))
with check (public.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role));