-- Durable close receipts allow retry after a lost response, without replaying cookies.
create table private.profile_close_receipts (
  profile_id uuid not null references public.browser_profiles(id) on delete cascade,
  lock_token uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  cookies_updated_at timestamptz not null,
  closed_at timestamptz not null default clock_timestamp(),
  primary key (profile_id, lock_token)
);
revoke all on private.profile_close_receipts from public, anon, authenticated;

create or replace function public.mutate_profile_lease(_profile_id uuid, _lock_token uuid, _operation text, _cookies_enc text default null, _device_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.browser_profiles; l public.profile_locks; receipt private.profile_close_receipts; expiry timestamptz;
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
  if _operation = 'close' then
    select * into receipt from private.profile_close_receipts
      where profile_id = _profile_id and lock_token = _lock_token and user_id = auth.uid();
    if found then
      return jsonb_build_object('expiresAt', receipt.closed_at, 'cookiesUpdatedAt', receipt.cookies_updated_at);
    end if;
  end if;
  select * into l from public.profile_locks where profile_id = _profile_id;
  if not found or _lock_token is null or l.lock_token <> _lock_token or l.user_id <> auth.uid()
     or (_operation <> 'close' and l.expires_at <= clock_timestamp())
     or (_device_id is not null and l.device_id <> _device_id) then
    raise exception 'Session lease lost; reopen the profile' using errcode = '42501';
  end if;
  -- An expired device can close only while its token has not been superseded.
  if _operation in ('save', 'close') and _cookies_enc is not null then
    update public.browser_profiles set cookies_enc = _cookies_enc where id = _profile_id returning * into p;
  end if;
  expiry := clock_timestamp() + interval '5 minutes';
  if _operation = 'close' then
    insert into private.profile_close_receipts(profile_id, lock_token, user_id, cookies_updated_at)
      values (_profile_id, _lock_token, auth.uid(), p.cookies_updated_at);
    delete from public.profile_locks where profile_id = _profile_id;
  else
    update public.profile_locks set heartbeat_at = clock_timestamp(), expires_at = expiry where profile_id = _profile_id;
  end if;
  return jsonb_build_object('expiresAt', expiry, 'cookiesUpdatedAt', p.cookies_updated_at);
end
$$;

create function private.guard_running_profile_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare changed boolean;
begin
  changed := tg_op = 'DELETE';
  if tg_op = 'UPDATE' then
    changed := row(new.name, new.folder, new.tags, new.notes, new.proxy_id, new.fingerprint)
      is distinct from row(old.name, old.folder, old.tags, old.notes, old.proxy_id, old.fingerprint);
    if new.cookies_enc is distinct from old.cookies_enc then
      new.cookies_updated_at := greatest(clock_timestamp(), old.cookies_updated_at + interval '1 millisecond');
    end if;
  end if;
  if changed and exists (select 1 from public.profile_locks where profile_id = old.id and expires_at > clock_timestamp()) then
    raise exception 'Close the profile before changing or deleting it' using errcode = '55P03';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
-- Runs after profile_write_guard so the final revision remains strictly monotonic.
create trigger zz_profile_running_guard before update or delete on public.browser_profiles
  for each row execute function private.guard_running_profile_changes();
revoke all on function private.guard_running_profile_changes() from public, anon, authenticated;
