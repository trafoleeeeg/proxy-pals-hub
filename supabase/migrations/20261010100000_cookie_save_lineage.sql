-- A bounded, private proof of the CURRENT save. No cookie plaintext or extra
-- cookie copies. Legacy saves/imports/close invalidate it in the same transaction.
create table private.profile_cookie_save_proofs (
  profile_id uuid primary key references public.browser_profiles(id) on delete cascade,
  save_id uuid not null, user_id uuid not null references auth.users(id) on delete cascade,
  cookie_hash text not null check (cookie_hash ~ '^[0-9a-f]{64}$'),
  cookies_updated_at timestamptz not null
);
revoke all on private.profile_cookie_save_proofs from public, anon, authenticated;

create function private.invalidate_cookie_save_proof() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.cookies_enc is distinct from old.cookies_enc then
    delete from private.profile_cookie_save_proofs where profile_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_cookie_save_proof() from public, anon, authenticated;
create trigger invalidate_cookie_save_proof after update of cookies_enc on public.browser_profiles
for each row execute function private.invalidate_cookie_save_proof();

create function public.get_profile_cookie_save_proof(_profile_id uuid, _lock_token uuid, _device_id text)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare p public.browser_profiles; proof private.profile_cookie_save_proofs;
begin
  if auth.uid() is null or not private.can_access_profile(auth.uid(), _profile_id) then raise exception 'No profile access'; end if;
  select * into p from public.browser_profiles where id = _profile_id for update;
  -- Enforce the same access/token/device/expiry checks as normal heartbeats.
  perform public.mutate_profile_lease(_profile_id, _lock_token, 'heartbeat', null, _device_id);
  select * into proof from private.profile_cookie_save_proofs where profile_id = p.id and cookies_updated_at = p.cookies_updated_at;
  return jsonb_build_object('proof', case when proof.save_id is null then null else
    jsonb_build_object('saveId', proof.save_id, 'cookieHash', proof.cookie_hash, 'cookiesUpdatedAt', proof.cookies_updated_at) end);
end;
$$;
revoke all on function public.get_profile_cookie_save_proof(uuid, uuid, text) from public, anon;
grant execute on function public.get_profile_cookie_save_proof(uuid, uuid, text) to authenticated;

create function public.save_profile_cookie_checkpoint(_profile_id uuid, _lock_token uuid, _device_id text,
  _save_id uuid, _base_revision timestamptz, _cookie_hash text, _cookies_enc text)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare p public.browser_profiles; proof private.profile_cookie_save_proofs; result jsonb;
begin
  if auth.uid() is null or not private.can_access_profile(auth.uid(), _profile_id) then raise exception 'No profile access'; end if;
  if _save_id is null or _cookie_hash is null or _cookie_hash !~ '^[0-9a-f]{64}$' or _cookies_enc is null or octet_length(_cookies_enc) > 7000000 then raise exception 'Invalid cookie checkpoint'; end if;
  select * into p from public.browser_profiles where id = _profile_id for update;
  perform public.mutate_profile_lease(_profile_id, _lock_token, 'heartbeat', null, _device_id);
  select * into proof from private.profile_cookie_save_proofs where profile_id = p.id and cookies_updated_at = p.cookies_updated_at;
  if proof.save_id = _save_id then
    if proof.cookie_hash <> _cookie_hash or proof.user_id <> auth.uid() then raise exception 'Invalid cookie save identity'; end if;
  elsif date_trunc('milliseconds', p.cookies_updated_at) is distinct from _base_revision then
    return jsonb_build_object('ok', false, 'conflict', true, 'cookiesUpdatedAt', p.cookies_updated_at,
      'proof', case when proof.save_id is null then null else jsonb_build_object('saveId', proof.save_id, 'cookieHash', proof.cookie_hash, 'cookiesUpdatedAt', proof.cookies_updated_at) end);
  else
    result := public.mutate_profile_lease(_profile_id, _lock_token, 'save', _cookies_enc, _device_id);
    insert into private.profile_cookie_save_proofs(profile_id, save_id, user_id, cookie_hash, cookies_updated_at)
      values (_profile_id, _save_id, auth.uid(), _cookie_hash, (result->>'cookiesUpdatedAt')::timestamptz)
      on conflict (profile_id) do update set save_id = excluded.save_id, user_id = excluded.user_id,
        cookie_hash = excluded.cookie_hash, cookies_updated_at = excluded.cookies_updated_at;
    select * into proof from private.profile_cookie_save_proofs where profile_id = p.id;
  end if;
  return jsonb_build_object('ok', true, 'cookiesUpdatedAt', proof.cookies_updated_at,
    'proof', jsonb_build_object('saveId', proof.save_id, 'cookieHash', proof.cookie_hash, 'cookiesUpdatedAt', proof.cookies_updated_at));
end;
$$;
revoke all on function public.save_profile_cookie_checkpoint(uuid, uuid, text, uuid, timestamptz, text, text) from public, anon;
grant execute on function public.save_profile_cookie_checkpoint(uuid, uuid, text, uuid, timestamptz, text, text) to authenticated;
