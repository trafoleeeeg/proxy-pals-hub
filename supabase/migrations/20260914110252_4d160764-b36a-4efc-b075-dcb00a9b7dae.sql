revoke all on function public.has_role(uuid, uuid, public.app_role) from public, anon;
revoke all on function public.is_team_member(uuid, uuid) from public, anon;
revoke all on function public.can_access_profile(uuid, uuid) from public, anon;
revoke all on function public.my_team_ids(uuid) from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.has_role(uuid, uuid, public.app_role) to authenticated;
grant execute on function public.is_team_member(uuid, uuid) to authenticated;
grant execute on function public.can_access_profile(uuid, uuid) to authenticated;