const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchPanelResponse } = require("../runtime/panel-network.cjs");

test("native protocol aborts an RPC stalled before headers, without replay", async () => {
  let signal, calls = 0;
  await assert.rejects(fetchPanelResponse(async (_request, options) => {
    calls++; signal = options.signal; return new Promise(() => {});
  }, new Request("https://panel.test/_serverFn/test"), {}, 5), { name: "TimeoutError" });
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test("native protocol bounds response body too and recovers on the next request", async () => {
  let signal;
  await assert.rejects(fetchPanelResponse(async (_request, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
  }, new Request("https://panel.test/_serverFn/test"), {}, 5), { name: "TimeoutError" });
  assert.equal(signal.aborted, true);
  const response = await fetchPanelResponse(async () => new Response('{"ok":true}', { status: 403, headers: { "Content-Type": "application/json" } }), new Request("https://panel.test/_serverFn/test"));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
});

test("native forwarding preserves caller cancellation and empty response statuses", async () => {
  const caller = new AbortController(); let signal;
  const request = new Request("https://panel.test/_serverFn/test", { signal: caller.signal });
  const response = await fetchPanelResponse(async (_request, options) => { signal = options.signal; return new Response(null, { status: 204 }); }, request, {}, 5);
  assert.equal(response.status, 204);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signal.aborted, false);
  caller.abort(); assert.equal(signal.aborted, true);
});
