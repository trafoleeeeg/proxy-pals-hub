CREATE TABLE public.profile_bookmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.browser_profiles(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  url text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profile_bookmarks_profile_idx ON public.profile_bookmarks (profile_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_bookmarks TO authenticated;
GRANT ALL ON public.profile_bookmarks TO service_role;

ALTER TABLE public.profile_bookmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bookmarks owner all" ON public.profile_bookmarks
  FOR ALL TO authenticated
  USING (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role))
  WITH CHECK (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role));

CREATE POLICY "bookmarks member read" ON public.profile_bookmarks
  FOR SELECT TO authenticated
  USING (private.can_access_profile(auth.uid(), profile_id));

CREATE TRIGGER profile_bookmarks_set_updated_at
  BEFORE UPDATE ON public.profile_bookmarks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();