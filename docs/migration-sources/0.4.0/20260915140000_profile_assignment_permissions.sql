-- Membership rows have no UPDATE policy. FOR KEY SHARE under an invoker
-- therefore hides those rows. This RPC has explicit owner and team guards.
alter function public.set_profiles_access(uuid,uuid[],uuid,boolean) security definer;
