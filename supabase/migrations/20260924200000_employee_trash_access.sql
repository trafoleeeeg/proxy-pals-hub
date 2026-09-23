-- Deleting an active profile is an employee permission; managing the resulting
-- trash is exclusively an owner capability, independent of profile.delete.
-- These functions retain their signatures for existing desktop clients.
CREATE OR REPLACE FUNCTION public.list_trashed_profiles(_team_id uuid)
RETURNS TABLE(id uuid, name text, folder text, deleted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_role(auth.uid(), _team_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Нет доступа: корзина доступна только владельцу команды' USING ERRCODE = '42501';
  END IF;
  -- Authorize BEFORE retention cleanup: employees must not trigger a purge.
  DELETE FROM public.browser_profiles p WHERE p.team_id = _team_id
    AND p.deleted_at < clock_timestamp() - interval '14 days';
  RETURN QUERY SELECT p.id, p.name, p.folder, p.deleted_at
    FROM public.browser_profiles p WHERE p.team_id = _team_id AND p.deleted_at IS NOT NULL
    ORDER BY p.deleted_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.restore_trashed_profile(_team_id uuid, _profile_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE target public.browser_profiles;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_role(auth.uid(), _team_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Нет доступа: корзина доступна только владельцу команды' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target FROM public.browser_profiles WHERE id = _profile_id AND team_id = _team_id FOR UPDATE;
  IF NOT FOUND OR target.deleted_at IS NULL OR target.deleted_at < clock_timestamp() - interval '14 days' THEN
    RAISE EXCEPTION 'Профиль недоступен для восстановления' USING ERRCODE = '42501';
  END IF;
  UPDATE public.browser_profiles SET deleted_at = NULL, deleted_by = NULL WHERE id = _profile_id;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id)
    VALUES (_team_id, auth.uid(), 'profile.restored', 'profile', _profile_id);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.list_trashed_profiles(uuid), public.restore_trashed_profile(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_trashed_profiles(uuid), public.restore_trashed_profile(uuid, uuid) TO authenticated;

-- A delete-only employee must not require profile.edit merely to lock the
-- selected rows. The existing trash RPC validates ownership, folder access,
-- cardinality, and live leases before its SECURITY DEFINER soft deletion.
CREATE OR REPLACE FUNCTION public.bulk_mutate_profiles(_team_id uuid, _profile_ids uuid[], _operation text, _changes jsonb DEFAULT '{}'::jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path TO '' AS $$
DECLARE affected integer;
BEGIN
  IF _operation = 'delete' THEN
    affected := public.trash_profiles(_team_id, _profile_ids);
    INSERT INTO public.audit_log(team_id, user_id, action, target_type, meta)
      VALUES (_team_id, auth.uid(), 'profiles.bulk_delete', 'profile', jsonb_build_object('count', affected));
    RETURN affected;
  END IF;
  IF _operation IS DISTINCT FROM 'update' THEN
    RAISE EXCEPTION 'Invalid bulk operation' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'profile.edit') THEN
    RAISE EXCEPTION 'Недостаточно прав для изменения профилей' USING ERRCODE = '42501';
  END IF;
  IF cardinality(_profile_ids) IS NULL OR cardinality(_profile_ids) NOT BETWEEN 1 AND 200
    OR cardinality(_profile_ids) <> (SELECT count(DISTINCT i) FROM unnest(_profile_ids) i) THEN
    RAISE EXCEPTION 'Invalid profile selection' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.browser_profiles WHERE team_id = _team_id AND id = ANY(_profile_ids)
    AND deleted_at IS NULL ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> cardinality(_profile_ids) THEN RAISE EXCEPTION 'Profile selection contains unavailable or cross-team profiles' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.browser_profiles p WHERE p.id = ANY(_profile_ids)
      AND NOT private.can_use_folder(auth.uid(), _team_id, p.folder)) THEN
    RAISE EXCEPTION 'В выборе есть профили из недоступных вам папок' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profile_locks WHERE profile_id = ANY(_profile_ids) AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'Close the selected profiles first' USING ERRCODE = '55P03';
  END IF;
  IF _changes IS NULL OR jsonb_typeof(_changes) <> 'object' OR _changes = '{}'::jsonb
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(_changes) k WHERE k NOT IN ('folder', 'tags', 'notes', 'proxyId', 'fingerprint'))
    OR (_changes ? 'fingerprint' AND jsonb_typeof(_changes->'fingerprint') <> 'object') THEN
    RAISE EXCEPTION 'Invalid profile changes' USING ERRCODE = '22023';
  END IF;
  IF _changes ? 'proxyId' AND NOT private.has_permission(auth.uid(), _team_id, 'profile.proxy') THEN
    RAISE EXCEPTION 'Недостаточно прав для смены прокси профиля' USING ERRCODE = '42501';
  END IF;
  IF _changes ? 'folder' AND NOT private.can_use_folder(auth.uid(), _team_id, _changes->>'folder') THEN
    RAISE EXCEPTION 'Целевая папка вам недоступна' USING ERRCODE = '42501';
  END IF;
  UPDATE public.browser_profiles SET
    folder = CASE WHEN _changes ? 'folder' THEN _changes->>'folder' ELSE folder END,
    tags = CASE WHEN _changes ? 'tags' THEN ARRAY(SELECT jsonb_array_elements_text(_changes->'tags')) ELSE tags END,
    notes = CASE WHEN _changes ? 'notes' THEN _changes->>'notes' ELSE notes END,
    proxy_id = CASE WHEN _changes ? 'proxyId' THEN (_changes->>'proxyId')::uuid ELSE proxy_id END,
    fingerprint = CASE WHEN _changes ? 'fingerprint' THEN fingerprint || (_changes->'fingerprint') ELSE fingerprint END
    WHERE team_id = _team_id AND id = ANY(_profile_ids);
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, meta)
    VALUES (_team_id, auth.uid(), 'profiles.bulk_update', 'profile', jsonb_build_object('count', affected));
  RETURN affected;
END $$;

-- Prevent direct table writes from setting/backdating deletion metadata or
-- restoring hidden rows. Only the authorized SECURITY DEFINER trash RPCs can
-- change these columns. Normal profile edits and permitted soft deletion stay
-- available; retention cron/service operations are unaffected.
DROP POLICY IF EXISTS "profiles insert active only" ON public.browser_profiles;
CREATE POLICY "profiles insert active only" ON public.browser_profiles AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);
DROP POLICY IF EXISTS "profiles update active only" ON public.browser_profiles;
CREATE POLICY "profiles update active only" ON public.browser_profiles AS RESTRICTIVE
  FOR UPDATE TO authenticated USING (deleted_at IS NULL)
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);
REVOKE DELETE ON public.browser_profiles FROM authenticated;
