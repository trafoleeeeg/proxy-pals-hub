CREATE TABLE public.agent_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  created_by uuid REFERENCES auth.users(id),
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_keys TO authenticated;
GRANT ALL ON public.agent_keys TO service_role;

ALTER TABLE public.agent_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent keys owner all" ON public.agent_keys
  FOR ALL TO authenticated
  USING (private.has_role(auth.uid(), team_id, 'owner'::app_role))
  WITH CHECK (private.has_role(auth.uid(), team_id, 'owner'::app_role));

CREATE INDEX agent_keys_hash_idx ON public.agent_keys (key_hash);
CREATE INDEX agent_keys_team_idx ON public.agent_keys (team_id);

CREATE TRIGGER agent_keys_updated
  BEFORE UPDATE ON public.agent_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS agent_key_id uuid REFERENCES public.agent_keys(id) ON DELETE SET NULL;