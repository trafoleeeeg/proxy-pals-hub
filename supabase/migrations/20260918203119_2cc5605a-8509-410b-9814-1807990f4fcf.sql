alter function public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint, uuid, boolean)
  set lock_timeout = '5s';
alter function public.save_profile_browser_settings(uuid, jsonb, boolean, numeric, jsonb, bigint, uuid, boolean)
  set statement_timeout = '15s';

alter function public.ensure_workspace()
  set lock_timeout = '5s';
alter function public.ensure_workspace()
  set statement_timeout = '15s';