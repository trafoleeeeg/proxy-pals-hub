REVOKE ALL ON FUNCTION public.get_team_bookmark_defaults(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.save_team_bookmark_defaults(uuid, jsonb, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_team_bookmark_defaults(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_team_bookmark_defaults(uuid, jsonb, boolean) TO authenticated;