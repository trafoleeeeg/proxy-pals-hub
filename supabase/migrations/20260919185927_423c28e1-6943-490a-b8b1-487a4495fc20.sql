REVOKE EXECUTE ON FUNCTION public.set_folder_access(uuid, text, uuid, boolean) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.transfer_profiles(uuid, uuid[], text, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.set_folder_access(uuid, text, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_profiles(uuid, uuid[], text, uuid) TO authenticated;