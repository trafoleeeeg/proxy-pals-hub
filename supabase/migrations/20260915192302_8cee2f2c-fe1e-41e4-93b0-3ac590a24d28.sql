create function private.guard_active_proxy_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if row(new.protocol, new.host, new.port, new.username, new.password_enc)
    is distinct from row(old.protocol, old.host, old.port, old.username, old.password_enc)
    and exists (select 1 from public.browser_profiles p join public.profile_locks l on l.profile_id = p.id
      where p.proxy_id = old.id and l.expires_at > clock_timestamp()) then
    raise exception 'Close profiles using this proxy before changing its connection settings' using errcode = '55P03';
  end if;
  return new;
end
$$;
create trigger proxy_connection_guard before update on public.proxies
  for each row execute function private.guard_active_proxy_settings();
revoke all on function private.guard_active_proxy_settings() from public, anon, authenticated;

create or replace function private.guard_profile_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.team_id is distinct from old.team_id
    or (new.created_by is distinct from old.created_by and not (
      new.created_by is null and not exists (select 1 from auth.users where id = old.created_by)
    ))) then
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