revoke execute on function public.set_member_scope(uuid, uuid, text) from public, anon;
grant execute on function public.set_member_scope(uuid, uuid, text) to authenticated;