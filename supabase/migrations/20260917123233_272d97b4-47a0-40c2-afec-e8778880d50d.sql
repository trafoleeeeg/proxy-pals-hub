CREATE TABLE public.profile_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  color text NOT NULL DEFAULT 'primary' CHECK (color IN ('primary', 'success', 'warning', 'destructive', 'muted')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);
GRANT SELECT ON public.profile_statuses TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.profile_statuses TO authenticated;
GRANT ALL ON public.profile_statuses TO service_role;
ALTER TABLE public.profile_statuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "status members read" ON public.profile_statuses FOR SELECT TO authenticated USING (private.is_team_member(auth.uid(), team_id));
CREATE POLICY "status owner insert" ON public.profile_statuses FOR INSERT TO authenticated WITH CHECK (private.has_role(auth.uid(), team_id, 'owner'));
CREATE POLICY "status owner update" ON public.profile_statuses FOR UPDATE TO authenticated USING (private.has_role(auth.uid(), team_id, 'owner')) WITH CHECK (private.has_role(auth.uid(), team_id, 'owner'));
CREATE POLICY "status owner delete" ON public.profile_statuses FOR DELETE TO authenticated USING (private.has_role(auth.uid(), team_id, 'owner'));
CREATE TRIGGER profile_statuses_updated BEFORE UPDATE ON public.profile_statuses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.profile_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  field_type text NOT NULL DEFAULT 'text' CHECK (field_type IN ('text', 'number', 'date', 'url')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);
GRANT SELECT ON public.profile_field_definitions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.profile_field_definitions TO authenticated;
GRANT ALL ON public.profile_field_definitions TO service_role;
ALTER TABLE public.profile_field_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "field members read" ON public.profile_field_definitions FOR SELECT TO authenticated USING (private.is_team_member(auth.uid(), team_id));
CREATE POLICY "field owner insert" ON public.profile_field_definitions FOR INSERT TO authenticated WITH CHECK (private.has_role(auth.uid(), team_id, 'owner'));
CREATE POLICY "field owner update" ON public.profile_field_definitions FOR UPDATE TO authenticated USING (private.has_role(auth.uid(), team_id, 'owner')) WITH CHECK (private.has_role(auth.uid(), team_id, 'owner'));
CREATE POLICY "field owner delete" ON public.profile_field_definitions FOR DELETE TO authenticated USING (private.has_role(auth.uid(), team_id, 'owner'));
CREATE TRIGGER profile_field_definitions_updated BEFORE UPDATE ON public.profile_field_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.browser_profiles
  ADD COLUMN status_id uuid REFERENCES public.profile_statuses(id) ON DELETE SET NULL,
  ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX profile_statuses_team_position_idx ON public.profile_statuses(team_id, position, created_at);
CREATE INDEX profile_field_definitions_team_position_idx ON public.profile_field_definitions(team_id, position, created_at);
CREATE INDEX browser_profiles_status_id_idx ON public.browser_profiles(status_id);

CREATE OR REPLACE FUNCTION private.guard_profile_metadata()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF NEW.status_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profile_statuses s WHERE s.id = NEW.status_id AND s.team_id = NEW.team_id
  ) THEN
    RAISE EXCEPTION 'Profile status belongs to another team' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.custom_fields) <> 'object' THEN
    RAISE EXCEPTION 'Custom fields must be an object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(NEW.custom_fields) key
    WHERE NOT EXISTS (
      SELECT 1 FROM public.profile_field_definitions f
      WHERE f.id::text = key AND f.team_id = NEW.team_id
    )
  ) THEN
    RAISE EXCEPTION 'Custom field belongs to another team' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profile_metadata_guard
BEFORE INSERT OR UPDATE OF team_id, status_id, custom_fields ON public.browser_profiles
FOR EACH ROW EXECUTE FUNCTION private.guard_profile_metadata();