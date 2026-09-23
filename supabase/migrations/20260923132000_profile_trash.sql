ALTER TABLE public.browser_profiles
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid;
REVOKE DELETE ON public.browser_profiles FROM authenticated;
CREATE INDEX browser_profiles_trash_idx ON public.browser_profiles(team_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- Archived profiles must not appear in ordinary reads, cookie/lease flows or
-- direct client updates. The trash API below is the sole read/restore path.
CREATE POLICY "active profiles only" ON public.browser_profiles AS RESTRICTIVE
  FOR SELECT TO authenticated USING (deleted_at IS NULL);

CREATE OR REPLACE FUNCTION private.can_access_profile(_user_id uuid, _profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.browser_profiles p
    WHERE p.id = _profile_id AND p.deleted_at IS NULL AND (
      private.has_role(_user_id, p.team_id, 'owner')
      OR private.has_profile_access(_user_id, p.id)
      OR private.has_folder_profile_access(_user_id, p.id)
    ))
$$;

CREATE OR REPLACE FUNCTION public.trash_profiles(_team_id uuid, _profile_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE affected integer;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'profile.delete') THEN
    RAISE EXCEPTION 'Недостаточно прав для удаления профилей' USING ERRCODE = '42501';
  END IF;
  IF cardinality(_profile_ids) IS NULL OR cardinality(_profile_ids) NOT BETWEEN 1 AND 200
    OR cardinality(_profile_ids) <> (SELECT count(DISTINCT id) FROM unnest(_profile_ids) id) THEN
    RAISE EXCEPTION 'Некорректный выбор профилей' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.browser_profiles WHERE team_id = _team_id AND id = ANY(_profile_ids)
    AND deleted_at IS NULL ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> cardinality(_profile_ids) THEN
    RAISE EXCEPTION 'Профили недоступны или уже в корзине' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.browser_profiles p WHERE p.id = ANY(_profile_ids)
    AND NOT private.can_use_folder(auth.uid(), _team_id, p.folder)) THEN
    RAISE EXCEPTION 'Нет доступа к папке профиля' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profile_locks WHERE profile_id = ANY(_profile_ids) AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'Сначала закройте профили' USING ERRCODE = '55P03';
  END IF;
  UPDATE public.browser_profiles SET deleted_at = clock_timestamp(), deleted_by = auth.uid()
    WHERE team_id = _team_id AND id = ANY(_profile_ids);
  RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.bulk_mutate_profiles(_team_id uuid, _profile_ids uuid[], _operation text, _changes jsonb DEFAULT '{}'::jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path TO '' AS $$
DECLARE affected integer; needed text;
BEGIN
  IF _operation = 'delete' THEN needed := 'profile.delete';
  ELSIF _operation = 'update' THEN needed := 'profile.edit';
  ELSE RAISE EXCEPTION 'Invalid bulk operation' USING ERRCODE = '22023'; END IF;
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, needed) THEN
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
  IF _operation = 'delete' THEN
    PERFORM public.trash_profiles(_team_id, _profile_ids);
  ELSE
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
  END IF;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, meta)
    VALUES (_team_id, auth.uid(), 'profiles.bulk_' || _operation, 'profile', jsonb_build_object('count', affected));
  RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.list_trashed_profiles(_team_id uuid)
RETURNS TABLE(id uuid, name text, folder text, deleted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.teams t WHERE t.id = _team_id AND (
      private.has_role(auth.uid(), _team_id, 'owner')
      OR EXISTS (SELECT 1 FROM public.team_members m WHERE m.team_id = _team_id AND m.user_id = auth.uid())
      OR public.is_superadmin()
    )) THEN
    RAISE EXCEPTION 'Нет доступа к команде' USING ERRCODE = '42501';
  END IF;
  -- No pg_cron on local DB: purge on opening the trash as a fallback.
  DELETE FROM public.browser_profiles p WHERE p.team_id = _team_id
    AND p.deleted_at < clock_timestamp() - interval '14 days';
  RETURN QUERY SELECT p.id, p.name, p.folder, p.deleted_at
    FROM public.browser_profiles p WHERE p.team_id = _team_id AND p.deleted_at IS NOT NULL
      AND private.can_use_folder(auth.uid(), _team_id, p.folder)
    ORDER BY p.deleted_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.restore_trashed_profile(_team_id uuid, _profile_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE target public.browser_profiles;
BEGIN
  IF auth.uid() IS NULL OR NOT private.has_permission(auth.uid(), _team_id, 'profile.delete') THEN
    RAISE EXCEPTION 'Недостаточно прав для восстановления профиля' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target FROM public.browser_profiles WHERE id = _profile_id AND team_id = _team_id FOR UPDATE;
  IF NOT FOUND OR target.deleted_at IS NULL OR target.deleted_at < clock_timestamp() - interval '14 days'
    OR NOT private.can_use_folder(auth.uid(), _team_id, target.folder) THEN
    RAISE EXCEPTION 'Профиль недоступен для восстановления' USING ERRCODE = '42501';
  END IF;
  UPDATE public.browser_profiles SET deleted_at = NULL, deleted_by = NULL WHERE id = _profile_id;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id)
    VALUES (_team_id, auth.uid(), 'profile.restored', 'profile', _profile_id);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.trash_profiles(uuid, uuid[]), public.list_trashed_profiles(uuid), public.restore_trashed_profile(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.trash_profiles(uuid, uuid[]), public.list_trashed_profiles(uuid), public.restore_trashed_profile(uuid, uuid) TO authenticated;

-- Agent API uses a server-only key, not auth.uid(); keep it on the same
-- retention path and never expose this helper to ordinary JWT clients.
CREATE OR REPLACE FUNCTION public.trash_agent_profile(_team_id uuid, _profile_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.browser_profiles WHERE id = _profile_id AND team_id = _team_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Профиль не найден' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profile_locks WHERE profile_id = _profile_id AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'Сначала закройте профиль' USING ERRCODE = '55P03';
  END IF;
  UPDATE public.browser_profiles SET deleted_at = clock_timestamp(), deleted_by = NULL
    WHERE id = _profile_id AND team_id = _team_id AND deleted_at IS NULL;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.trash_agent_profile(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trash_agent_profile(uuid, uuid) TO service_role;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $schedule$SELECT cron.schedule('umbra-profile-trash-retention', '45 3 * * *', 'DELETE FROM public.browser_profiles WHERE deleted_at < clock_timestamp() - interval ''14 days''')$schedule$;
  END IF;
END $$;
