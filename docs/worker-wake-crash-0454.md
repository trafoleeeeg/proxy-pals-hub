# 0.4.54: stopped Service Workers and provisional renderer contexts

## Evidence

The opted-in, local 0.4.53 diagnostic journal recorded a `worker-restarted`
protective stop at 2026-10-09 21:34:58 UTC. The profile then completed its normal
worker/tab/cookie/outbox shutdown. This event was not a whole-application crash.

A separate local native dump from 20:30:07 UTC has exception `0x80000003` in
`blink::MainThreadDebugger::ensureDefaultContextInGroup`, called by
`v8_inspector::V8RuntimeAgentImpl::evaluate`. Matching symbols and the pinned
Chromium source identify the provisional-frame DCHECK in that default-context
path. Only exception metadata and function names were inspected; no memory,
cookie contents, tokens or dump files are included in the repository.

These findings do not identify every historical application exit.

## Changes and safety boundaries

- `Inspector.targetCrashed` also describes an ordinary stopped Service Worker.
  Holding its debugger attachment keeps its stopped DevTools host alive. Release
  that attachment so wake creates a new target, then require its actual
  `waitingForDebugger` flag and apply all policy before resuming site code.
- A persisted host's in-place restart is not assumed paused: Chromium does not
  set `should_pause_on_start_` on every host-creation path. Unexpected in-place
  restart still fails closed. Outbound traffic stays gated until actual target
  destruction and connection closure, not merely a detach/close acknowledgement.
- A detach response can race target destruction. Its failure is not proof of a
  live worker; the existing destruction deadline remains authoritative.
- Page/dedicated-worker evaluations now use announced `uniqueContextId` values.
  Page locale verification selects the main world of that target's frame. There
  is no numeric-ID or unbound default-context fallback. Context destruction,
  session detach and target closure cancel stale access.
- No engine rebuild, database change, production-cookie overwrite, privacy
  bypass or forced application restart is part of this change.

## Regression coverage

The exact pinned Windows engine passed first-statement worker identity checks,
repeated stop/wake cycles, simultaneous profiles, registration updates,
persistent profile reopen, app restart, and encrypted cookie recovery after an
isolated abrupt process exit. The separate native privacy fixture passed
cross-process frames and strict/normal/exact-origin policy checks.

Unit tests retain startup-pause, ambiguous-resume, missing-destruction and
unexpected-restart fail-closed checks. Context tests cover provisional readiness,
isolated-world exclusion, matching-frame selection, child-session isolation,
numeric ID reuse, missing unique identities and closure while waiting.

Publication additionally requires the unchanged GitHub code, dependency and
native Windows packaging gates. A green test suite does not promise that every
unrelated native crash or future OS/driver issue has been eliminated.
