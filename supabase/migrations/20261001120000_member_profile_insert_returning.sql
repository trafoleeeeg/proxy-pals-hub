-- INSERT ... RETURNING checks SELECT policies against the new tuple. A
-- STABLE helper that looks the profile up by id cannot see that tuple in the
-- command snapshot, even though the employee has access to its folder.
-- Authorize using the tuple's team/folder and existing membership/access rows
-- instead. Do not change INSERT rights, private-main or trash restrictions.
BEGIN;

DROP POLICY IF EXISTS "bp member read" ON public.browser_profiles;
CREATE POLICY "bp member read" ON public.browser_profiles FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND private.is_team_member(auth.uid(), team_id)
    AND private.can_use_folder(auth.uid(), team_id, folder)
  );

COMMIT;
