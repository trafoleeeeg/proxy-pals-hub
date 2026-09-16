# Windows Reliability Release 0.4.0

## Scope

- Windows x64 NSIS installer; one uniquely named executable, its blockmap and `latest.yml`.
- Background update checks/downloads, visible errors, explicit restart, and installation blocked while profiles run.
- Isolated persistent profile sessions, authenticated HTTP/SOCKS5 proxy tunnels, bounded proxy checks, and no direct fallback after configured-proxy failure.
- Profile address bar and managed tabs, with remote content separated from privileged browser controls.
- Encrypted local cookie checkpoints and a retryable encrypted close outbox.
- Token-owned server leases, atomic bulk mutations, owner-controlled team assignment, and JSON/Netscape cookie import/export.

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
4. Merge the feature branch only via a PR with green checks, then publish the corresponding web panel. Server functions and the database migration must be deployed together.
5. Create the matching `v0.4.0` tag. The workflow builds a draft GitHub release. Check installer, blockmap and `latest.yml`, then verify fresh installation and a real installed-version upgrade before publishing the release.
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

Cookies synchronize through the server. Local storage, IndexedDB, caches and other Chromium partition data persist locally but are not transferred between team devices. Device-clock skew can affect timestamp-based local/cloud cookie precedence and requires further protocol work. Revoked or superseded lease snapshots are kept in a local encrypted archive after the server rejects their close; they cannot overwrite the newer cloud session. The archive requires an explicit recovery decision before those cookies can be reused.

Production deployment, signing, fresh installation, installed-to-installed upgrade, and the full native DPAPI restart test must be recorded separately. Passing unit tests does not establish these outcomes.
