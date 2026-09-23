# Windows Reliability and Release

## Scope

- Windows x64 NSIS installer; one uniquely named executable, its blockmap and `latest.yml`.
- Background update checks/downloads, visible errors, and installation after a normal quit once profiles are closed.
- Isolated persistent profile sessions, authenticated HTTP/SOCKS5 proxy tunnels, bounded proxy checks, and no direct fallback after configured-proxy failure.
- Profile address bar and managed tabs, with remote content separated from privileged browser controls.
- Encrypted local cookie checkpoints and a retryable encrypted close outbox.
- Managed unpacked browser extensions for current and future profiles.
- Mobile proxy IP rotation links with encrypted storage and visible status/history.
- Token-owned server leases, atomic bulk mutations, owner-controlled team assignment, and JSON/Netscape cookie import/export.

## Core updates and security

Electron ships the Chromium engine inside the desktop installer, so a Chromium security release is delivered as a tested stable Electron update. The `Automatic Electron release` workflow checks the official npm registry daily at 05:23 UTC. When a newer stable Electron exists, it creates a separate PR changing only Electron, its dependency lock and the application patch version. It explicitly starts code checks, dependency audits and the native Windows build for that exact commit, merges only after all succeed, then creates a tag and builds and publishes the installer. Installed clients receive that release through their existing updater. Chromium updates arrive when included in a stable Electron release; beta/alpha releases are excluded.

The workflow never force-pushes or writes commits directly to main. An independently verified release gate requires a merged bot PR, identical tested/released contents and successful checks. Updated packages execute only in workflows with read-only repository tokens; the maintenance job uses `npm --ignore-scripts` to resolve the lockfile. It stops on failed checks, unexpected file/dependency changes, a newer published installer, pending desktop edits or a concurrent main-branch change. A failed update stays as a reviewable PR. An unchanged pending PR can be retested automatically; an edited or outdated PR needs review or closure. If the PR already merged but its tagged build/publication failed, the next run retries that release after verifying its provenance again. No failed update is silently installed.

GitHub Actions must be allowed to create pull requests in the repository's workflow permissions. The workflow uses the short-lived built-in token, without storing a personal GitHub key. Explicit workflow dispatch is necessary because token-generated PR/tag events do not automatically run the normal checks without approval. Dependabot remains enabled for other desktop dependencies, panel packages and GitHub Actions; Electron is excluded there to avoid duplicate update PRs.

Packaged clients check the GitHub release manifest over HTTPS in the background and download updates automatically. The downloaded installer is installed on the next normal application quit, after Umbra has flushed profile cookies and closed profile windows. Prerelease and downgrade updates are disabled. The packaged panel URL is fixed to the HTTPS production origin; a local environment override is available only during development.

The repository also runs a daily dependency audit. The lockfiles pin the audited versions of transitive packages, including the current brace-expansion, js-yaml and nanoid security fixes. Keep the Electron update PR and its generated lockfile together so the runtime, Chromium and audit result stay aligned.

The profile panel can store an HTTPS mobile-provider rotation link encrypted on the server. A rotation request records the previous exit IP, pending state, result, error and last change time; the desktop client performs the follow-up check before showing the new IP. The new migration `20260917100000_3b6c3d41-2e4b-4ad8-a4ef-c7f04647b6e2` must be applied together with the panel/server release.

Extensions are selected as unpacked Manifest V2/V3 folders in the desktop panel. Umbra copies them into its per-user data directory, loads them into active sessions and applies the same set to profiles created later. The extension binaries are local to each computer and are not synchronized through the database.

## Release Gates

From the repository root:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test tests/
bun run build
npm --prefix desktop ci
node desktop/node_modules/electron/install.js
$env:UMBRA_REQUIRE_NATIVE = "1"
$env:UMBRA_REQUIRE_DPAPI = "1"
npm --prefix desktop test
npm --prefix desktop run build:win
npm --prefix desktop run verify:release
```

Run the strict native test in a normal Windows user account. A sandbox service account without DPAPI cannot verify OS-encrypted session restart. A skipped test is not a successful encryption check. Production must continue to reject opening profiles when OS encryption is unavailable.

The Windows CI job enforces both native test gates. Linux CI installs Electron and runs the native proxy and browser tests under a virtual display with the Chromium sandbox enabled; OS-encrypted restart is verified by the Windows gate. Visual tests live under `tests/visual` and use synthetic data, never production credentials.

## Coordinated Rollout

1. Close all profiles on every old client and confirm session synchronization. The lease migration invalidates old leases. Schedule this as a coordinated upgrade, not a rolling mixed-client release.
2. Back up the database and retain the current `APP_ENCRYPTION_KEY`. Changing that key makes existing encrypted proxy passwords and cookies unreadable.
3. Apply migrations in `supabase/migrations/` in timestamp order through the normal Lovable/Supabase deployment process. The 0.4.0 changes are recorded under deployed versions `20260915192121` through `20260915192302`. Their original reviewed sources are archived in `docs/migration-sources/0.4.0/`; do not execute that archive or reapply changes already present in the migration ledger. Do not run migrations from an agent against production directly.
   The navigation/team/trash rollout additionally requires `20260923120000_member_permission_enforcement.sql`, `20260923130000_folder_order.sql`, `20260923131000_audit_retention.sql`, `20260923132000_profile_trash.sql`, `20260924100000_enable_retention_cron.sql`, and `20260924111000_explicit_unfiled_access.sql` in timestamp order. Check the migration ledger first and apply only missing versions. The cron migration enables Supabase `pg_cron` and schedules two retention jobs; verify both jobs in the Supabase Cron dashboard before merging. If the deployment role cannot enable the extension, enable it in the Supabase dashboard first, then reapply the migration through the normal deployment process. Back up the database before these changes. Access to `Без папки` is a separate grant from `Основная`.
4. Merge the feature branch only via a PR with green checks, then publish the corresponding web panel. Server functions and the database migration must be deployed together.
5. Create the matching `v<desktop version>` tag. The workflow builds a draft GitHub release. Check the installer, blockmap and `latest.yml`, then verify fresh installation and a real installed-version upgrade before publishing the release.
6. Clients whose old preload/updater bridge is broken may require one manual repair installation. Subsequent installed versions use the corrected update path. Do not uninstall with application-data deletion.

No code-signing certificate is bundled. Configure signing through protected CI secrets before a public signed release; a local unsigned build is a test artifact and may produce a Windows SmartScreen warning.

## Manual Acceptance

- Check a valid and invalid authenticated HTTP proxy and SOCKS5 proxy. A failed check must not show a false successful IP. Never use real credentials in test logs.
- Start two different profiles through different proxies, inspect the actual exit IP, navigate, and open tabs. Stop the proxy and confirm navigation fails instead of using the local connection.
- Log into a test site, close and reopen the profile and application, and check session cookies, persistent cookies and local storage.
- Close while temporarily offline, restart the app and confirm the saved close record synchronizes. Repeated close requests must not overwrite a newer device's session.
- Import JSON and Netscape cookies into a closed profile; export and reimport them. Try bulk folder/tag edits, bulk deletion, team assignment and removal.
- Try access from a second team and a member without profile grants. Try opening the same profile from a second device.
- Test updating an installed previous build to the next build, keeping profile data. A mocked updater test or matching manifest alone does not prove installation works.

## Known Boundaries

This is a stock Electron-based profile browser, not a custom Chromium antidetect kernel. There is no promise of undetectability or complete Vision feature parity. Worker and out-of-process-frame fingerprint consistency, font sets and canvas/audio behavior require a separate engine-level effort and independent site testing. Browser popups are managed tabs without an opener; popup form POST flows are not replayed.

Cookies synchronize through the server. Local storage, IndexedDB, caches and other Chromium partition data persist locally but are not transferred between team devices. A confirmed server cookie revision is authoritative across computers; the encrypted local snapshot is used only when the server supplies no revision. Revoked or superseded lease snapshots are kept in a local encrypted archive after the server rejects their close; they cannot overwrite the newer cloud session. The archive requires an explicit recovery decision before those cookies can be reused.

Production deployment, signing, fresh installation, installed-to-installed upgrade, and the full native DPAPI restart test must be recorded separately. Passing unit tests does not establish these outcomes.

