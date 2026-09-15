-- Revocation uses the same profile-row lock as lease mutation. A save already
-- in progress commits first; a save behind revocation must recheck access.
create function private.lock_revoked_profiles()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'team_members' then
    perform 1 from public.browser_profiles where team_id = old.team_id order by id for update;
  else
    perform 1 from public.browser_profiles where id = old.profile_id for update;
    delete from public.profile_locks where profile_id = old.profile_id and user_id = old.user_id;
  end if;
  return old;
end
$$;
create trigger member_revocation_lock before delete on public.team_members
  for each row execute function private.lock_revoked_profiles();
create trigger access_revocation_lock before delete on public.profile_access
  for each row execute function private.lock_revoked_profiles();

create function private.recheck_session_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if tg_table_name = 'browser_profiles' then
    if new.cookies_enc is not distinct from old.cookies_enc then return new; end if;
    target := old.id;
  elsif tg_op = 'DELETE' then target := old.profile_id;
  else target := new.profile_id;
  end if;
  if auth.uid() is not null and not private.can_access_profile(auth.uid(), target) then
    raise exception 'No profile access' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger lease_access_recheck before insert or update or delete on public.profile_locks
  for each row execute function private.recheck_session_access();
create trigger cookie_access_recheck before update on public.browser_profiles
  for each row execute function private.recheck_session_access();
revoke all on function private.lock_revoked_profiles(), private.recheck_session_access() from public, anon, authenticated;
