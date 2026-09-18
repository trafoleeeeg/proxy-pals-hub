DROP FUNCTION IF EXISTS public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint);

CREATE OR REPLACE FUNCTION public.save_profile_browser_settings(
  _profile_id uuid,
  _bookmarks jsonb,
  _bookmark_bar_visible boolean,
  _zoom_level numeric,
  _extensions jsonb,
  _expected_revision bigint DEFAULT NULL,
  _active_proxy_id uuid DEFAULT NULL,
  _proxy_failover boolean DEFAULT false
)
RETURNS public.profile_browser_settings
LANGUAGE plpgsql
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
      active_proxy_id = _active_proxy_id,
      proxy_failover = coalesce(_proxy_failover, false),
      revision = current_row.revision + 1,
      updated_by = auth.uid()
    WHERE profile_id = _profile_id
    RETURNING * INTO saved_row;
  ELSE
    IF _expected_revision IS NOT NULL AND _expected_revision <> 0 THEN
      RAISE EXCEPTION 'Browser settings changed on another device' USING errcode = '40001';
    END IF;
    INSERT INTO public.profile_browser_settings (
      profile_id, bookmarks, bookmark_bar_visible, zoom_level, extensions,
      active_proxy_id, proxy_failover, revision, updated_by
    ) VALUES (
      _profile_id, _bookmarks, _bookmark_bar_visible, _zoom_level, _extensions,
      _active_proxy_id, coalesce(_proxy_failover, false), 1, auth.uid()
    ) RETURNING * INTO saved_row;
  END IF;
  RETURN saved_row;
END;
$$;

REVOKE ALL ON FUNCTION public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint, uuid, boolean) TO service_role;