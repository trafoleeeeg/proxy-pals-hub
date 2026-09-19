DO $$
DECLARE
  target_team constant uuid := 'edab663b-a15f-4f9c-a914-fca4bce85d7e';
  super_user constant uuid := '8f9bf3e6-def2-47ac-938a-d37c7f6b33ff';
  source_team uuid;
  status_row record;
  field_row record;
  target_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profile_locks l
    JOIN public.browser_profiles p ON p.id = l.profile_id
    WHERE p.team_id <> target_team AND l.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Нельзя объединить команды: один из переносимых профилей сейчас запущен';
  END IF;

  ALTER TABLE public.teams DISABLE TRIGGER team_identity_guard;
  ALTER TABLE public.proxies DISABLE TRIGGER proxy_team_guard;
  ALTER TABLE public.browser_profiles DISABLE TRIGGER profile_metadata_guard;
  ALTER TABLE public.browser_profiles DISABLE TRIGGER profile_write_guard;

  FOR source_team IN SELECT id FROM public.teams WHERE id <> target_team ORDER BY created_at LOOP
    UPDATE public.proxies SET team_id = target_team WHERE team_id = source_team;

    FOR status_row IN SELECT id,name FROM public.profile_statuses WHERE team_id = source_team LOOP
      SELECT id INTO target_id FROM public.profile_statuses
      WHERE team_id = target_team AND lower(name) = lower(status_row.name) LIMIT 1;
      IF target_id IS NULL THEN
        UPDATE public.profile_statuses SET team_id = target_team WHERE id = status_row.id;
      ELSE
        UPDATE public.browser_profiles SET status_id = target_id WHERE status_id = status_row.id;
        DELETE FROM public.profile_statuses WHERE id = status_row.id;
      END IF;
      target_id := NULL;
    END LOOP;

    FOR field_row IN SELECT id,name FROM public.profile_field_definitions WHERE team_id = source_team LOOP
      SELECT id INTO target_id FROM public.profile_field_definitions
      WHERE team_id = target_team AND lower(name) = lower(field_row.name) LIMIT 1;
      IF target_id IS NULL THEN
        UPDATE public.profile_field_definitions SET team_id = target_team WHERE id = field_row.id;
      ELSE
        UPDATE public.browser_profiles
        SET custom_fields = (custom_fields - field_row.id::text) ||
          CASE WHEN custom_fields ? field_row.id::text
            THEN jsonb_build_object(target_id::text, custom_fields -> field_row.id::text)
            ELSE '{}'::jsonb END
        WHERE team_id = source_team;
        DELETE FROM public.profile_field_definitions WHERE id = field_row.id;
      END IF;
      target_id := NULL;
    END LOOP;

    UPDATE public.browser_profiles p
    SET folder = CASE WHEN EXISTS(
      SELECT 1 FROM public.profile_folders tf WHERE tf.team_id=target_team AND lower(tf.name)=lower(p.folder)
    ) THEN p.folder || ' — перенесено' ELSE p.folder END
    WHERE p.team_id=source_team;

    INSERT INTO public.profile_folders(team_id,name,is_default,created_by,created_at,updated_at)
    SELECT target_team,
      CASE WHEN EXISTS(SELECT 1 FROM public.profile_folders tf WHERE tf.team_id=target_team AND lower(tf.name)=lower(sf.name))
        THEN sf.name || ' — перенесено'
        ELSE sf.name END,
      false,sf.created_by,sf.created_at,sf.updated_at
    FROM public.profile_folders sf WHERE sf.team_id=source_team
    ON CONFLICT (team_id,name) DO NOTHING;

    UPDATE public.browser_profiles SET team_id = target_team WHERE team_id = source_team;
    UPDATE public.agent_keys SET team_id = target_team WHERE team_id = source_team;
    UPDATE public.audit_log SET team_id = target_team WHERE team_id = source_team;
    UPDATE public.team_invites SET team_id = target_team WHERE team_id = source_team;

    INSERT INTO public.folder_access(id,team_id,folder,user_id,granted_by,created_at)
    SELECT gen_random_uuid(),target_team,fa.folder,fa.user_id,fa.granted_by,fa.created_at
    FROM public.folder_access fa WHERE fa.team_id=source_team
    ON CONFLICT (team_id,folder,user_id) DO NOTHING;
    DELETE FROM public.folder_access WHERE team_id=source_team;

    INSERT INTO public.member_permissions(team_id,user_id,can_create_profile,can_edit_profile,can_delete_profile,can_change_profile_proxy,can_manage_folders,can_manage_proxies,can_manage_bookmarks,updated_by,updated_at)
    SELECT target_team,user_id,can_create_profile,can_edit_profile,can_delete_profile,can_change_profile_proxy,can_manage_folders,can_manage_proxies,can_manage_bookmarks,updated_by,updated_at
    FROM public.member_permissions WHERE team_id=source_team
    ON CONFLICT (team_id,user_id) DO NOTHING;
    DELETE FROM public.member_permissions WHERE team_id=source_team;

    INSERT INTO public.user_presence(user_id,team_id,last_seen_at,active_profile_id,device_label,created_at,updated_at)
    SELECT user_id,target_team,last_seen_at,active_profile_id,device_label,created_at,updated_at
    FROM public.user_presence WHERE team_id=source_team
    ON CONFLICT (user_id,team_id) DO UPDATE SET
      last_seen_at=greatest(public.user_presence.last_seen_at,excluded.last_seen_at),
      active_profile_id=CASE WHEN excluded.last_seen_at >= public.user_presence.last_seen_at THEN excluded.active_profile_id ELSE public.user_presence.active_profile_id END,
      device_label=CASE WHEN excluded.last_seen_at >= public.user_presence.last_seen_at THEN excluded.device_label ELSE public.user_presence.device_label END,
      updated_at=greatest(public.user_presence.updated_at,excluded.updated_at);
    DELETE FROM public.user_presence WHERE team_id=source_team;

    INSERT INTO public.team_members(team_id,user_id,role,scope,created_at)
    SELECT target_team,user_id,'member'::public.app_role,'member',created_at
    FROM public.team_members WHERE team_id=source_team
    ON CONFLICT (team_id,user_id) DO NOTHING;

    DELETE FROM public.teams WHERE id=source_team;
  END LOOP;

  UPDATE public.teams SET owner_id=super_user,name='Umbra' WHERE id=target_team;
  INSERT INTO public.team_members(team_id,user_id,role,scope)
  VALUES(target_team,super_user,'owner','manager')
  ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner',scope='manager';
  UPDATE public.team_members SET role='member',scope='member'
  WHERE team_id=target_team AND user_id<>super_user;
  DELETE FROM public.member_permissions WHERE team_id=target_team AND user_id=super_user;
  DELETE FROM public.folder_access WHERE team_id=target_team AND user_id=super_user;

  ALTER TABLE public.proxies ENABLE TRIGGER proxy_team_guard;
  ALTER TABLE public.teams ENABLE TRIGGER team_identity_guard;
  ALTER TABLE public.browser_profiles ENABLE TRIGGER profile_metadata_guard;
  ALTER TABLE public.browser_profiles ENABLE TRIGGER profile_write_guard;
EXCEPTION WHEN OTHERS THEN
  ALTER TABLE public.browser_profiles ENABLE TRIGGER profile_write_guard;
  ALTER TABLE public.browser_profiles ENABLE TRIGGER profile_metadata_guard;
  ALTER TABLE public.proxies ENABLE TRIGGER proxy_team_guard;
  ALTER TABLE public.teams ENABLE TRIGGER team_identity_guard;
  RAISE;
END $$;