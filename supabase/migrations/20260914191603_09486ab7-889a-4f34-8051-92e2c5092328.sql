create or replace function private.has_role(_user_id uuid, _team_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where user_id=_user_id and team_id=_team_id and role=_role)
$$;
create or replace function private.is_team_member(_user_id uuid, _team_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where user_id=_user_id and team_id=_team_id)
$$;
create or replace function private.can_access_profile(_user_id uuid, _profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.browser_profiles bp
    where bp.id=_profile_id
      and (private.has_role(_user_id, bp.team_id, 'owner') or exists (
        select 1 from public.profile_access pa where pa.profile_id=bp.id and pa.user_id=_user_id))
  )
$$;
grant execute on function private.has_role(uuid,uuid,public.app_role), private.is_team_member(uuid,uuid), private.can_access_profile(uuid,uuid) to authenticated, service_role;

drop policy "teams update" on public.teams;
create policy "teams update" on public.teams for update to authenticated using (private.has_role(auth.uid(), id, 'owner'));
drop policy "teams read" on public.teams;
create policy "teams read" on public.teams for select to authenticated using (owner_id = auth.uid() or private.is_team_member(auth.uid(), id));

drop policy "members read" on public.team_members;
create policy "members read" on public.team_members for select to authenticated using (user_id = auth.uid() or private.has_role(auth.uid(), team_id, 'owner'));
drop policy "members delete" on public.team_members;
create policy "members delete" on public.team_members for delete to authenticated using (private.has_role(auth.uid(), team_id, 'owner') and user_id <> auth.uid());

drop policy "invites owner all" on public.team_invites;
create policy "invites owner all" on public.team_invites for all to authenticated using (private.has_role(auth.uid(), team_id, 'owner')) with check (private.has_role(auth.uid(), team_id, 'owner'));

drop policy "proxies owner all" on public.proxies;
create policy "proxies owner all" on public.proxies for all to authenticated using (private.has_role(auth.uid(), team_id, 'owner')) with check (private.has_role(auth.uid(), team_id, 'owner'));
drop policy "proxies member read" on public.proxies;
create policy "proxies member read" on public.proxies for select to authenticated using (
  private.is_team_member(auth.uid(), team_id) and exists (
    select 1 from public.browser_profiles bp join public.profile_access pa on pa.profile_id = bp.id
    where bp.proxy_id = proxies.id and pa.user_id = auth.uid()));

drop policy "bp owner all" on public.browser_profiles;
create policy "bp owner all" on public.browser_profiles for all to authenticated using (private.has_role(auth.uid(), team_id, 'owner')) with check (private.has_role(auth.uid(), team_id, 'owner'));
drop policy "bp member read" on public.browser_profiles;
create policy "bp member read" on public.browser_profiles for select to authenticated using (private.has_role(auth.uid(), team_id, 'owner') or private.has_profile_access(auth.uid(), id));

drop policy "access owner all" on public.profile_access;
create policy "access owner all" on public.profile_access for all to authenticated
using (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'))
with check (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'));

drop policy "audit insert" on public.audit_log;
create policy "audit insert" on public.audit_log for insert to authenticated with check (user_id = auth.uid() and private.is_team_member(auth.uid(), team_id));
drop policy "audit owner read" on public.audit_log;
create policy "audit owner read" on public.audit_log for select to authenticated using (private.has_role(auth.uid(), team_id, 'owner'));

drop policy "locks read" on public.profile_locks;
create policy "locks read" on public.profile_locks for select to authenticated using (private.can_access_profile(auth.uid(), profile_id));
drop policy "locks insert" on public.profile_locks;
create policy "locks insert" on public.profile_locks for insert to authenticated with check (user_id = auth.uid() and private.can_access_profile(auth.uid(), profile_id));
drop policy "locks update" on public.profile_locks;
create policy "locks update" on public.profile_locks for update to authenticated using (user_id = auth.uid() or private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'));
drop policy "locks delete" on public.profile_locks;
create policy "locks delete" on public.profile_locks for delete to authenticated using (user_id = auth.uid() or private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'));

drop function if exists public.my_team_ids(uuid);
drop function if exists public.can_access_profile(uuid,uuid);
drop function if exists public.has_role(uuid,uuid,public.app_role);
drop function if exists public.is_team_member(uuid,uuid);