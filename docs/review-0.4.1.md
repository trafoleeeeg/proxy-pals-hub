# Review of 0.4.1

The initial UI implementation incorrectly treated a reachable proxy as proof of
IP rotation, had no browser profile home page, and assumed every installed
client already exposed the extension API.

The reviewed implementation:

- Confirms rotation only after observing an IP different from the freshly
  checked baseline. Temporary provider outages and unchanged addresses are
  retried. Requests use a conditional database claim; stale replies cannot
  complete a newer request. Confirmed IP pairs survive later connection checks.
- Shows actual per-profile engine, proxy check, timezone, languages, screen,
  hardware, extension and cookie information on the native new-tab page.
  Only the isolated toolbar receives this summary; websites receive no bridge.
- Reads the clipboard only after an explicit paste action in the trusted panel.
- Handles older clients without the new IPC methods. Extension bundles are
  local, copied into managed directories, and applied to active/future profiles.
  Loading and registry changes are serialized; registry paths and symlinks are
  not trusted. Removal unregisters and unloads bundles without deleting code
  that may still be used by a running profile.
- Starts browser chrome alongside session preparation, shows navigation
  progress before a remote page finishes, and switches existing tabs without
  waiting for another tab's network request. Route authentication has a short
  cache; server authorization still runs on every operation.

Validation: frozen Bun installation, type checks, production panel build,
148 server/UI unit tests, 35 Windows runtime tests including DPAPI restart,
native extension content scripts and home-page privacy, and desktop/mobile
panel scenarios (26 tests). Dependency audits reported no known advisories in either
lockfile at the time of review.

Apply both 20260917 proxy-rotation migrations through Lovable before publishing
the new panel. Release the matching Windows binary for the new native features.
Electron supports a subset of Chrome extension APIs; unpacked extensions must
be compatible with that subset. Bundles are not synchronized across computers.

The daily Electron update configuration opens tested dependency PRs. It does
not itself merge PRs or publish an installer; automatic client installation
starts only after a matching GitHub release is published.

Follow-up: the gated `Automatic Electron release` workflow now completes the
PR, validation, merge and installer publication steps. See windows-release.md
for its schedule, safeguards and failure recovery.
