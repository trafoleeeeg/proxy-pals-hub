-- Mobile proxy rotation metadata. The provider URL is encrypted by the
-- application; only status and IP transition data are exposed to the panel.
ALTER TABLE public.proxies
  ADD COLUMN IF NOT EXISTS rotation_url_enc text,
  ADD COLUMN IF NOT EXISTS rotation_status text NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS rotation_previous_ip text,
  ADD COLUMN IF NOT EXISTS rotation_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotation_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotation_last_error text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proxies_rotation_status_check'
      AND conrelid = 'public.proxies'::regclass
  ) THEN
    ALTER TABLE public.proxies
      ADD CONSTRAINT proxies_rotation_status_check
      CHECK (rotation_status IN ('not_configured', 'ready', 'changing', 'success', 'error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS proxies_rotation_status_idx
  ON public.proxies(team_id, rotation_status);
