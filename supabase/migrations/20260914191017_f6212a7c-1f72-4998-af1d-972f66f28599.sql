drop policy if exists "teams read" on public.teams;
create policy "teams read" on public.teams for select to authenticated
using (owner_id = auth.uid() or public.is_team_member(auth.uid(), id));

drop function if exists public.whoami();

delete from public.teams t where not exists (select 1 from public.team_members m where m.team_id = t.id) and t.created_at > now() - interval '1 hour';