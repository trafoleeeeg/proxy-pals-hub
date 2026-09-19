REVOKE ALL ON FUNCTION private.owner_can_read_user(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.owner_can_read_user(uuid, uuid) TO authenticated;