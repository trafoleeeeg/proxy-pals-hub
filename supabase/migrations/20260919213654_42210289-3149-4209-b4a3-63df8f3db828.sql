CREATE OR REPLACE FUNCTION private.owner_can_read_user(_viewer uuid, _user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT private.is_superadmin(_viewer)
    OR EXISTS (
      SELECT 1
      FROM public.team_members m
      JOIN public.teams t ON t.id = m.team_id
      WHERE m.user_id = _user
        AND t.owner_id = _viewer
    )
$$;

INSERT INTO public.profiles (id, email, display_name)
SELECT u.id, u.email, COALESCE(NULLIF(u.raw_user_meta_data ->> 'display_name', ''), split_part(u.email, '@', 1))
FROM auth.users u
JOIN private.super_admins s ON s.user_id = u.id
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    display_name = COALESCE(NULLIF(public.profiles.display_name, ''), EXCLUDED.display_name);