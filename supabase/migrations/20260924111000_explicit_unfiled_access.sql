-- The empty folder is a distinct "Без папки" location, not an alias of
-- "Основная". Folder-access policies already compare exact folder values;
-- allow managers to grant the empty location explicitly through the RPC.
CREATE OR REPLACE FUNCTION public.set_folder_access(_team_id uuid, _folder text, _user_id uuid, _granted boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT private.can_manage(auth.uid(), _team_id) THEN
    RAISE EXCEPTION 'Недостаточно прав для выдачи доступа к папке' USING ERRCODE = '42501';
  END IF;
  IF _folder IS NULL OR length(_folder) > 200 OR _granted IS NULL THEN
    RAISE EXCEPTION 'Некорректная папка' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.team_members WHERE team_id = _team_id AND user_id = _user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Пользователь не состоит в команде' USING ERRCODE = '42501'; END IF;
  IF _granted THEN
    INSERT INTO public.folder_access(team_id, folder, user_id, granted_by)
      VALUES (_team_id, _folder, _user_id, auth.uid())
      ON CONFLICT (team_id, folder, user_id) DO NOTHING;
  ELSE
    DELETE FROM public.folder_access WHERE team_id = _team_id AND folder = _folder AND user_id = _user_id;
  END IF;
  INSERT INTO public.audit_log(team_id, user_id, action, target_type, target_id, meta)
    VALUES (_team_id, auth.uid(), 'folder.access_changed', 'member', _user_id,
      jsonb_build_object('folder', _folder, 'granted', _granted));
  RETURN true;
END $$;

