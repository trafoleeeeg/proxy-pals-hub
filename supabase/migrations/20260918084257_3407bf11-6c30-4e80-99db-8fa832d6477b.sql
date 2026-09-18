CREATE TABLE public.profile_browser_settings (
  profile_id uuid PRIMARY KEY REFERENCES public.browser_profiles(id) ON DELETE CASCADE,
  bookmarks jsonb NOT NULL DEFAULT '[]'::jsonb,
  bookmark_bar_visible boolean NOT NULL DEFAULT true,
  zoom_level numeric(4,2) NOT NULL DEFAULT 0,
  extensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_browser_settings TO authenticated;
GRANT ALL ON public.profile_browser_settings TO service_role;

ALTER TABLE public.profile_browser_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "browser settings member read" ON public.profile_browser_settings
  FOR SELECT TO authenticated
  USING (private.can_access_profile(auth.uid(), profile_id));

CREATE POLICY "browser settings owner insert" ON public.profile_browser_settings
  FOR INSERT TO authenticated
  WITH CHECK (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role));

CREATE POLICY "browser settings owner update" ON public.profile_browser_settings
  FOR UPDATE TO authenticated
  USING (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role))
  WITH CHECK (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role));

CREATE POLICY "browser settings owner delete" ON public.profile_browser_settings
  FOR DELETE TO authenticated
  USING (private.has_role(auth.uid(), private.profile_team(profile_id), 'owner'::app_role));

CREATE OR REPLACE FUNCTION private.guard_profile_browser_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF jsonb_typeof(NEW.bookmarks) <> 'array'
     OR jsonb_array_length(NEW.bookmarks) > 64
     OR octet_length(NEW.bookmarks::text) > 262144
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.bookmarks) item
       WHERE jsonb_typeof(item) <> 'object'
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(item) key WHERE key NOT IN ('id', 'title', 'url', 'favicon'))
          OR coalesce(item->>'id', '') !~ '^[0-9a-fA-F-]{36}$'
          OR length(coalesce(item->>'title', '')) > 120
          OR length(coalesce(item->>'url', '')) > 2048
          OR coalesce(item->>'url', '') !~ '^https?://'
          OR length(coalesce(item->>'favicon', '')) > 90000
     ) THEN
    RAISE EXCEPTION 'Invalid bookmark settings' USING errcode = '22023';
  END IF;
  IF NEW.zoom_level < -3 OR NEW.zoom_level > 5 THEN
    RAISE EXCEPTION 'Invalid zoom level' USING errcode = '22023';
  END IF;
  IF jsonb_typeof(NEW.extensions) <> 'array'
     OR jsonb_array_length(NEW.extensions) > 64
     OR octet_length(NEW.extensions::text) > 131072
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.extensions) item
       WHERE jsonb_typeof(item) <> 'object'
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(item) key WHERE key NOT IN ('id', 'url', 'pinned'))
          OR coalesce(item->>'id', '') !~ '^[a-f0-9]{24}$'
          OR length(coalesce(item->>'url', '')) > 2048
          OR coalesce(item->>'url', '') !~ '^https://'
          OR jsonb_typeof(item->'pinned') <> 'boolean'
     ) THEN
    RAISE EXCEPTION 'Invalid extension settings' USING errcode = '22023';
  END IF;
  IF NEW.revision < 1 THEN
    RAISE EXCEPTION 'Invalid settings revision' USING errcode = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profile_browser_settings_guard
  BEFORE INSERT OR UPDATE ON public.profile_browser_settings
  FOR EACH ROW EXECUTE FUNCTION private.guard_profile_browser_settings();

CREATE OR REPLACE FUNCTION public.save_profile_browser_settings(
  _profile_id uuid,
  _bookmarks jsonb,
  _bookmark_bar_visible boolean,
  _zoom_level numeric,
  _extensions jsonb,
  _expected_revision bigint DEFAULT NULL
)
RETURNS public.profile_browser_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  current_row public.profile_browser_settings;
  saved_row public.profile_browser_settings;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_role(auth.uid(), private.profile_team(_profile_id), 'owner'::app_role) THEN
    RAISE EXCEPTION 'Only the team owner can edit browser settings' USING errcode = '42501';
  END IF;
  PERFORM 1 FROM public.browser_profiles WHERE id = _profile_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile unavailable' USING errcode = '42501';
  END IF;
  SELECT * INTO current_row FROM public.profile_browser_settings WHERE profile_id = _profile_id FOR UPDATE;
  IF FOUND THEN
    IF _expected_revision IS NOT NULL AND current_row.revision <> _expected_revision THEN
      RAISE EXCEPTION 'Browser settings changed on another device' USING errcode = '40001';
    END IF;
    UPDATE public.profile_browser_settings SET
      bookmarks = _bookmarks,
      bookmark_bar_visible = _bookmark_bar_visible,
      zoom_level = _zoom_level,
      extensions = _extensions,
      revision = current_row.revision + 1,
      updated_by = auth.uid()
    WHERE profile_id = _profile_id
    RETURNING * INTO saved_row;
  ELSE
    IF _expected_revision IS NOT NULL AND _expected_revision <> 0 THEN
      RAISE EXCEPTION 'Browser settings changed on another device' USING errcode = '40001';
    END IF;
    INSERT INTO public.profile_browser_settings (
      profile_id, bookmarks, bookmark_bar_visible, zoom_level, extensions, revision, updated_by
    ) VALUES (
      _profile_id, _bookmarks, _bookmark_bar_visible, _zoom_level, _extensions, 1, auth.uid()
    ) RETURNING * INTO saved_row;
  END IF;
  RETURN saved_row;
END;
$$;

REVOKE ALL ON FUNCTION public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint) TO service_role;