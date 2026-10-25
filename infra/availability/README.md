# Umbra database availability

This separate Cloudflare Worker checks the existing Supabase project six times
per day, including when the owner's laptop is off. It does not deploy or rebuild
the desktop app, read user tables, change sessions, or use administrator keys.

## Components

- New migration `20261025113100_availability_probe.sql`: a zero-argument,
  `SECURITY INVOKER` SQL function returning only `true`. Only `anon` receives
  execution permission; existing table grants and RLS remain unchanged.
- `worker.mjs`: scheduled POST to that fixed RPC using only the project's public
  publishable key. Redirects, unexpected responses, network hangs and server
  errors must fail visibly rather than count as a successful check.
- `wrangler.jsonc`: an independent scheduled-only Worker, not the Pages app.
  The four-hour schedule uses UTC and does not depend on GitHub repository
  activity or a local Codex process.

## Deploy and verify

1. Run `node --test infra/availability/database.test.cjs infra/availability/worker.test.mjs`
   with existing project dependencies.
   Follow the normal PR/green-check process; do not change the desktop version.
2. Apply the new migration once to the existing target project. Never restore
   another database archive, change application keys, or re-import cookies.
3. Configure the public key binding required by the Worker. Never provide a
   secret/service-role key, database password, owner token or user session.
4. Deploy this Worker separately on Workers Free. Keep public Workers/preview
   URLs disabled and configure the schedule from the committed configuration.
5. Verify a real RPC response is HTTP 200 with JSON `true`, then check the
   Cloudflare scheduled event outcome. Deployment alone is not proof of an
   actual scheduled execution; propagation may take up to 15 minutes.

Terminal failures are recorded as failed Worker invocations with sanitized
technical logs. This is not, by itself, an email notification or proof that a
missing execution would be detected. Do not promise alerts unless separately
configured and verified.

## Limits

This is legitimate database availability monitoring and generates real SQL
activity rather than merely fetching a static page or Auth gateway. Supabase
says a few daily database requests are typically enough to avoid an inactivity
pause; it does not guarantee that a Free project will never pause. Provider
incidents, quotas and future policy changes remain possible. No paid tier or
automatic billing upgrade is part of this setup.

Sources:

- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/database/functions
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/limits/
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
