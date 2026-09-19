create or replace function public.superadmin_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id from private.super_admins s
$$;

revoke all on function public.superadmin_ids() from public, anon;
grant execute on function public.superadmin_ids() to authenticated;