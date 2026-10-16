const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppShutdown } = require("../runtime/app-shutdown.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ profiles = true, confirm = async () => false, save = async () => {} } = {}) {
  const calls = [], events = [];
  let controller;
  const app = { quit() {
    calls.push("quit-request");
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    controller.beforeQuit(event);
    if (!event.prevented) calls.push("exited");
  } };
  controller = createAppShutdown({ app, hasOpenProfiles: () => profiles,
    closeProfiles: async () => { calls.push("save"); await save(); calls.push("saved"); },
    confirmQuit: async ({ source }) => { calls.push("confirm:" + source); return confirm(); },
    diagnose: (event, details) => events.push({ event, ...details }),
    onComplete: () => calls.push("cleanup"), onError: () => calls.push("error"),
  });
  return { app, controller, calls, events };
}
test("an unclassified quit with live profiles cannot close or save anything without consent", async () => {
  const f = fixture();
  f.app.quit();
  assert.equal(f.controller.isClosing(), true);
  await tick();
  assert.deepEqual(f.calls, ["quit-request", "confirm:unknown"]);
  assert.equal(f.controller.isClosing(), false);
  assert.equal(f.controller.isQuitting(), false);
  assert.deepEqual(f.events.map(row => row.phase), ["begin", "cancelled"]);
});
test("repeated panel and native quit requests share one confirmation", async () => {
  const answer = deferred();
  const f = fixture({ confirm: () => answer.promise });
  f.controller.requestQuit("panel-close");
  f.controller.requestQuit("panel-close");
  f.app.quit();
  await tick();
  assert.equal(f.calls.filter(call => call.startsWith("confirm:")).length, 1);
  assert.ok(!f.calls.includes("save"));
  answer.resolve(false); await tick();
  assert.ok(!f.calls.includes("exited"));
  f.controller.requestQuit("panel-close"); await tick();
  assert.equal(f.calls.filter(call => call.startsWith("confirm:")).length, 2);
});
test("explicit confirmation waits for durable save before the one final quit", async () => {
  const saved = deferred();
  const f = fixture({ confirm: async () => true, save: () => saved.promise });
  f.controller.requestQuit("panel-close"); await tick();
  assert.ok(f.calls.includes("save"));
  assert.ok(!f.calls.includes("cleanup"));
  assert.ok(!f.calls.includes("exited"));
  f.app.quit();
  assert.equal(f.calls.filter(call => call === "save").length, 1);
  saved.resolve(); await tick();
  assert.deepEqual(f.calls.slice(-4), ["saved", "cleanup", "quit-request", "exited"]);
  assert.equal(f.controller.isQuitting(), true);
});
test("failed saving leaves the app alive and allows a new deliberate attempt", async () => {
  let attempts = 0;
  const f = fixture({ confirm: async () => true, save: async () => { if (++attempts === 1) throw new Error("synthetic storage error"); } });
  f.controller.requestQuit("panel-close"); await tick();
  assert.ok(!f.calls.includes("exited"));
  assert.equal(f.controller.isClosing(), false);
  assert.equal(f.controller.isQuitting(), false);
  f.controller.requestQuit("panel-close"); await tick();
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter(call => call === "exited").length, 1);
});
test("dismissed, nonboolean or failed confirmation never mutates profiles", async () => {
  for (const confirm of [async () => undefined, async () => 1, async () => { throw new Error("dialog unavailable"); }]) {
    const f = fixture({ confirm });
    f.app.quit(); await tick();
    assert.ok(!f.calls.includes("save"));
    assert.ok(!f.calls.includes("exited"));
    assert.equal(f.controller.isClosing(), false);
  }
});
test("empty app closes normally without an extra confirmation", async () => {
  const f = fixture({ profiles: false });
  f.controller.requestQuit("all-windows-closed"); await tick();
  assert.ok(!f.calls.some(call => call.startsWith("confirm:")));
  assert.deepEqual(f.calls, ["quit-request", "save", "saved", "cleanup", "quit-request", "exited"]);
});
test("diagnostics failures cannot terminate a live profile or bypass confirmation", async () => {
  let saved = false;
  const controller = createAppShutdown({ app: { quit() {} }, hasOpenProfiles: () => true,
    closeProfiles: async () => { saved = true; }, confirmQuit: async () => false,
    diagnose: () => { throw new Error("journal unavailable"); } });
  controller.beforeQuit({ preventDefault() {} }); await tick();
  assert.equal(saved, false);
  assert.equal(controller.isClosing(), false);
});
