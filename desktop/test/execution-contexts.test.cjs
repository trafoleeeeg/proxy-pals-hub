const test = require("node:test");
const assert = require("node:assert/strict");
const { executionContexts } = require("../runtime/execution-contexts.cjs");
const announce = (tracker, id, uniqueId, sessionId, frameId = "frame") => tracker.update("Runtime.executionContextCreated", {
  context: { id, uniqueId, name: "", auxData: { isDefault: true, frameId } },
}, sessionId);

test("context IDs can be reused but stale unique identities must never be used", async () => {
  const tracker = executionContexts();
  announce(tracker, 1, "first");
  assert.equal(await tracker.wait(undefined, "frame"), "first");
  tracker.update("Runtime.executionContextsCleared", {});
  const pending = tracker.wait(undefined, "frame");
  announce(tracker, 1, "second");
  assert.equal(await pending, "second");
  tracker.update("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "first" });
  assert.equal(await tracker.wait(undefined, "frame"), "second", "a delayed old destroy must not erase the reused numeric ID");
  tracker.update("Runtime.executionContextDestroyed", { executionContextUniqueId: "second" });
  const next = tracker.wait(undefined, "frame");
  announce(tracker, 1, "third");
  assert.equal(await next, "third");
  tracker.dispose();
});

test("context announcements and detach stay scoped to the matching debugger session", async () => {
  const tracker = executionContexts();
  announce(tracker, 1, "parent");
  const child = tracker.wait("child", "frame");
  announce(tracker, 1, "other", "other");
  announce(tracker, 1, "child", "child");
  assert.equal(await child, "child");
  tracker.close("child");
  announce(tracker, 2, "late-child", "child");
  await assert.rejects(tracker.wait("child"), /detached/);
  const pending = tracker.wait("waiting");
  tracker.dispose();
  await assert.rejects(pending, /detached/);
});

test("missing unique identity cannot fall back to a numeric/default context", async () => {
  const tracker = executionContexts({ timeout: 20 });
  announce(tracker, 1, undefined);
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(tracker.wait(), /unavailable/); }
  finally { clearTimeout(keepAlive); tracker.dispose(); }
});

test("a confirmed named worker uses its announced unique context without page-only flags", async () => {
  const tracker = executionContexts();
  tracker.registerTarget("named-worker", "worker");
  const pending = tracker.wait("named-worker");
  tracker.update("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "worker-unique", name: "site-assigned-name" } }, "named-worker");
  assert.equal(await pending, "worker-unique");
  tracker.close("named-worker");
  tracker.registerTarget("named-worker", "worker");
  tracker.update("Runtime.executionContextCreated", { context: { id: 2, uniqueId: "late", name: "site-assigned-name" } }, "named-worker");
  await assert.rejects(tracker.wait("named-worker"), /detached/);
  tracker.dispose();
});

test("named contexts cannot widen page, iframe, unknown-session or isolated-world selection", async () => {
  const tracker = executionContexts({ timeout: 15 });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    for (const type of ["page", "iframe", "unknown", "worker"]) {
      tracker.registerTarget(type, type);
      tracker.update("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "wrong-" + type, name: "named-world",
        ...(type === "worker" ? { auxData: { isDefault: false } } : {}) } }, type);
      await assert.rejects(tracker.wait(type), /unavailable/);
    }
    tracker.registerTarget("missing-id", "worker");
    tracker.update("Runtime.executionContextCreated", { context: { id: 1, name: "named-worker" } }, "missing-id");
    await assert.rejects(tracker.wait("missing-id"), /unavailable/);
  } finally { clearTimeout(keepAlive); tracker.dispose(); }
});
