revoke all on function public.is_superadmin() from public, anon;
grant execute on function public.is_superadmin() to authenticated;