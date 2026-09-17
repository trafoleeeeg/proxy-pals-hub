-- Preserve the confirmed IP pair independently of subsequent connection checks.
ALTER TABLE public.proxies ADD COLUMN IF NOT EXISTS rotation_new_ip text;