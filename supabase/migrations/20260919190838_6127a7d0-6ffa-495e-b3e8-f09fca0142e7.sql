CREATE TABLE public.profile_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_folders TO authenticated;
GRANT ALL ON public.profile_folders TO service_role;
ALTER TABLE public.profile_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "folders team read" ON public.profile_folders FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.team_members m WHERE m.team_id = profile_folders.team_id AND m.user_id = auth.uid()));

CREATE POLICY "folders manager write" ON public.profile_folders FOR ALL TO authenticated
USING (private.can_manage(auth.uid(), team_id))
WITH CHECK (private.can_manage(auth.uid(), team_id) AND length(btrim(name)) BETWEEN 1 AND 200);

CREATE TRIGGER profile_folders_updated BEFORE UPDATE ON public.profile_folders
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.browser_profiles ALTER COLUMN folder SET DEFAULT 'Основная';

CREATE TABLE public.user_presence (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  active_profile_id uuid REFERENCES public.browser_profiles(id) ON DELETE SET NULL,
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);

GRANT SELECT, INSERT, UPDATE ON public.user_presence TO authenticated;
GRANT ALL ON public.user_presence TO service_role;
ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "presence self write" ON public.user_presence FOR ALL TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.team_members m WHERE m.team_id = user_presence.team_id AND m.user_id = auth.uid()));

CREATE POLICY "presence manager read" ON public.user_presence FOR SELECT TO authenticated
USING (private.can_manage(auth.uid(), team_id));

CREATE TRIGGER user_presence_updated BEFORE UPDATE ON public.user_presence
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.touch_presence(_team_id uuid, _profile_id uuid DEFAULT NULL, _device_label text DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare seen timestamptz;
begin
  if auth.uid() is null or not exists (
    select 1 from public.team_members m where m.team_id = _team_id and m.user_id = auth.uid()
  ) then
    raise exception 'Нет доступа к команде' using errcode = '42501';
  end if;
  if length(_device_label) > 200 then
    raise exception 'Некорректное устройство' using errcode = '22023';
  end if;
  if _profile_id is not null and not private.can_access_profile(auth.uid(), _profile_id) then
    _profile_id := null;
  end if;
  insert into public.user_presence(user_id, team_id, last_seen_at, active_profile_id, device_label)
  values (auth.uid(), _team_id, clock_timestamp(), _profile_id, _device_label)
  on conflict (user_id, team_id) do update set
    last_seen_at = clock_timestamp(),
    active_profile_id = excluded.active_profile_id,
    device_label = coalesce(excluded.device_label, public.user_presence.device_label)
  returning last_seen_at into seen;
  return seen;
end
$function$;

REVOKE ALL ON FUNCTION public.touch_presence(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.touch_presence(uuid, uuid, text) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.profile_folders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_presence;