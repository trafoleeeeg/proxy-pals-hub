-- Optional timezone from a proxied geolocation lookup of the verified exit IP.
-- Existing profiles and proxy assignments are deliberately unchanged.
ALTER TABLE public.proxies
  ADD COLUMN IF NOT EXISTS geo_timezone text;
