# Panel Component Checks

## Scoped Files

The resumed panel work changes these existing files:

- `src/lib/desktop.ts`
- `src/hooks/useDesktopProfileLifecycle.tsx`
- `src/components/profile-model.tsx`
- `src/components/profile-fingerprint.tsx`
- `src/components/profile-bulk.tsx`
- `src/components/profile-cookies.tsx`
- `src/routes/_authenticated/app.tsx`
- `src/routes/_authenticated/app.index.tsx`
- `src/routes/_authenticated/app.team.tsx`
- `src/routes/_authenticated/app.desktop.tsx`
- `tests/ui-lifecycle.test.ts`
- `tests/ui-profile-model.test.ts`

The standalone fixture, mocks, Playwright config/runner, `.pw.ts` scenarios,
TypeScript config and this report are all under `tests/visual/`.

## Run

Run from the repository root in PowerShell:

```powershell
node tests/visual/run.mjs
```

This is the recommended command. It starts the standalone Vite fixture at
`http://127.0.0.1:4179`, runs Playwright with installed Microsoft Edge, closes Vite,
and returns the test exit code. Port 4179 must be free. The Playwright config has
no `webServer`; the runner owns the only server. No root scripts or environment
files are modified.

To select one viewport or scenario, pass Playwright arguments to the runner:

```powershell
node tests/visual/run.mjs --project=mobile
node tests/visual/run.mjs --grep "cookie import"
```

The runner invokes:

```powershell
node node_modules/@playwright/test/cli.js test --config tests/visual/playwright.config.ts
```

Calling that command directly requires an already running fixture. The `.pw.ts`
suffix and explicit `testMatch` keep these checks out of `bun test tests/`.

## Coverage

- Real profiles, team, desktop and app layout components with the actual query,
  workspace and desktop lifecycle providers; React Strict Mode is enabled.
- Batch edit, folder clearing, filtered selection, deletion confirmation and
  failure recovery, team grant/revoke, batch fingerprint and creation validation.
- JSON file import, confirmation and clearing, JSON and Netscape downloads,
  locked profiles and role restrictions, and the 200-profile operation limit.
- Global session recovery after route/workspace changes, offline closure retry,
  update events, installation gating and absence of a beforeunload interceptor.
- Edge at 1440x1000 and 390x844. Horizontal page/dialog overflow and dialog bounds
  are asserted. Wide tables scroll inside their containers. Long names and
  invitations are included. Browser exceptions fail the tests.

Mock server functions, auth and desktop IPC exist only in this fixture. The
fixture Vite aliases are not imported by the production application. These
tests do not verify production authentication, real Electron IPC, updater
installation, browser fingerprints or a deployed database.

## Outputs

Generated files are ignored by `tests/visual/.gitignore` and are not for commit:

- `tests/visual/artifacts/report.json`: full machine-readable Playwright report.
- `tests/visual/artifacts/{desktop,mobile}-profiles.png`: actual profiles page.
- `tests/visual/artifacts/{desktop,mobile}-profile-editor.png`: tall editor.
- `tests/visual/artifacts/{desktop,mobile}-bulk-edit.png`: batch fields.
- `tests/visual/artifacts/{desktop,mobile}-bulk-fingerprint.png`: batch fingerprint.
- `tests/visual/artifacts/{desktop,mobile}-cookies-long-name.png`: cookie dialog.
- `tests/visual/artifacts/{desktop,mobile}-cookies-locked.png`: locked imports.
- `tests/visual/artifacts/{desktop,mobile}-delete.png`: deletion confirmation.
- `tests/visual/artifacts/{desktop,mobile}-team-members.png`: long invitations.
- `tests/visual/artifacts/{desktop,mobile}-team-access.png`: access assignment.
- `tests/visual/artifacts/{desktop,mobile}-global-sync-error.png`: offline closure.
- `tests/visual/artifacts/{desktop,mobile}-update-progress.png`: update state.
- `tests/visual/artifacts/{desktop,mobile}-member.png`: member view.
- `tests/visual/artifacts/results/`: failure screenshots and traces, when present.

The nested `tests/visual/tests/` directory from the initial relative reporter
path is also ignored. Current reporter paths are absolute and cannot create it.

## Other Checks

```powershell
& '../npm-cache/_npx/5c4f1b4a21be27f7/node_modules/bun/bin/bun.exe' test tests/
node node_modules/@typescript/native-preview/bin/tsgo --noEmit
node node_modules/@typescript/native-preview/bin/tsgo --noEmit -p tests/visual/tsconfig.json
```

The lifecycle unit suite includes a fresh controller after an acknowledgement
failure, using a simulated idempotent server close receipt. It also checks stale
tokens, native replies without snapshot IDs, exact durable acknowledgements,
device identity, missing tokens, unreadable storage and serialized cookie saves.

## Integration Notes

- Native `closeProfile` returns a runtime snapshot; only the close event/outbox
  record has `snapshotId`. The controller drains exact durable records after a
  native close and never substitutes the current lease for an old record.
- A stale or revoked lease cannot write cookies to the server. Once the server
  identifies that rejection as terminal, the controller archives the encrypted
  close snapshot locally and removes it from the retry queue. It does not
  overwrite the newer cloud session or discard the local snapshot.
- A cleared optional start URL is omitted from the server payload. The editor
  caps User-Agent at 1024 characters and offers integer memory values supported
  by the current runtime. Unsupported fonts/WebGL noise are not editable, and
  the editor states Electron's fingerprint limitations.
