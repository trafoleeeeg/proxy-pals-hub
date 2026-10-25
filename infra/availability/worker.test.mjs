import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import worker, { checkAvailability, PROJECT_ORIGIN, RPC_URL, TIMEOUT_MS } from "./worker.mjs";

const KEY = "sb_publishable_synthetic_public_key_for_tests_only";
const ENV = { SUPABASE_URL: PROJECT_ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY };
const MESSAGE = "Supabase availability check failed";
const json = body => new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } });
const jwt = (claims = {}) => [
  { alg: "HS256", typ: "JWT" }, { role: "anon", ref: "mqyjnsbhsfgorjzycwpd", ...claims },
].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).concat("synthetic_signature").join(".");

function run(fetcher, { environment = ENV, ...options } = {}) {
  const events = [];
  let time = 0;
  const promise = checkAvailability(environment, {
    fetcher, logger: event => events.push(event), now: () => time += 7, ...options,
  });
  return { promise, events };
}

test("scheduled-only Worker configuration has six UTC runs per day and no public URLs", async () => {
  assert.deepEqual(Object.keys(worker), ["scheduled"]);
  const config = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.main, "worker.mjs");
  assert.equal(config.compatibility_date, "2026-10-01");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.triggers.crons, ["17 */4 * * *"]);
  assert.deepEqual(config.vars, { SUPABASE_URL: PROJECT_ORIGIN });
  assert.equal(config.routes, undefined);
});

for (const key of [KEY, jwt()]) {
  test(`uses only the apikey header for ${key === KEY ? "publishable" : "legacy anon"} keys`, async () => {
    let requests = 0;
    const { promise, events } = run(async (url, init) => {
      requests++;
      assert.equal(url, "https://mqyjnsbhsfgorjzycwpd.supabase.co/rest/v1/rpc/umbra_availability");
      assert.equal(url, RPC_URL);
      assert.equal(init.method, "POST");
      assert.deepEqual(init.headers, { apikey: key, "content-type": "application/json", accept: "application/json" });
      assert.equal(init.body, "{}");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.equal(init.signal.aborted, false);
      return json("true");
    }, { environment: { ...ENV, SUPABASE_PUBLISHABLE_KEY: key } });
    assert.equal(await promise, undefined);
    assert.equal(requests, 1);
    assert.deepEqual(events, [{ stage: "healthy", status: 200, durationMs: 7, attempt: 1 }]);
  });
}

test("rejects wrong origins and secret, wrong-project or malformed keys before any fetch", async () => {
  const invalid = [
    { ...ENV, SUPABASE_URL: "https://other-project.supabase.co" },
    { ...ENV, SUPABASE_URL: PROJECT_ORIGIN + "/" },
    { ...ENV, SUPABASE_URL: "http://mqyjnsbhsfgorjzycwpd.supabase.co" },
    ...[undefined, "", "sb_secret_private_fixture", "sb_publishable_short", KEY + "\n",
      jwt({ role: "service_role" }), jwt({ role: "authenticated" }), jwt({ ref: "other-project" }),
      "malformed.jwt.value", "x".repeat(4097),
    ].map(key => ({ ...ENV, SUPABASE_PUBLISHABLE_KEY: key })),
  ];
  for (const environment of invalid) {
    let calls = 0;
    const { promise, events } = run(async () => { calls++; return json("true"); }, { environment });
    await assert.rejects(promise, { message: MESSAGE });
    assert.equal(calls, 0);
    assert.deepEqual(events, [{ stage: "configuration", status: 0, durationMs: 0, attempt: 0 }]);
  }
});

test("accepts a bounded JSON boolean delivered in separate body chunks", async () => {
  const body = new ReadableStream({ start(controller) {
    for (const part of [" ", "tr", "ue", "\n"]) controller.enqueue(new TextEncoder().encode(part));
    controller.close();
  } });
  const { promise } = run(async () => new Response(body, { headers: { "content-type": "application/json" } }));
  await promise;
});

test("rejects HTML, redirects, false, malformed and oversized bodies without retries", async () => {
  const redirected = json("true");
  Object.defineProperty(redirected, "redirected", { value: true });
  const responses = [
    new Response("<html>private fixture</html>", { headers: { "content-type": "text/html" } }),
    redirected, ...["false", "{}", "[]", "null", '"private fixture"', "invalid-json", " ".repeat(129) + "true"].map(json),
  ];
  for (const response of responses) {
    let calls = 0;
    const { promise, events } = run(async () => { calls++; return response; });
    await assert.rejects(promise, { message: MESSAGE });
    assert.equal(calls, 1);
    assert.equal(events[0].stage, "response");
    assert.equal(events[0].status, 200);
    assert.equal(JSON.stringify(events).includes("private fixture"), false);
  }
});

test("does not retry authentication, missing RPC or redirect HTTP failures", async () => {
  for (const status of [201, 202, 401, 403, 404, 302]) {
    let calls = 0;
    const { promise, events } = run(async () => { calls++; return new Response("private body", { status }); });
    await assert.rejects(promise, { message: MESSAGE });
    assert.equal(calls, 1);
    assert.deepEqual(events, [{ stage: "http", status, durationMs: 7, attempt: 1 }]);
  }
});

test("retries only once after a network, 429 or server failure", async () => {
  for (const first of ["network", 429, 500, 503]) {
    let calls = 0;
    const { promise, events } = run(async () => {
      calls++;
      if (calls === 1) {
        if (first === "network") throw new TypeError("private transport details");
        return new Response("private backend details", { status: first });
      }
      return json("true");
    });
    await promise;
    assert.equal(calls, 2);
    assert.deepEqual(events.map(event => [event.stage, event.attempt]), [[first === "network" ? "network" : "http", 1], ["healthy", 2]]);
  }
});

test("a successful HTTP response with a wrong result stops a pending retry", async () => {
  let calls = 0;
  const { promise, events } = run(async () => ++calls === 1 ? new Response("private", { status: 503 }) : json("false"));
  await assert.rejects(promise, { message: MESSAGE });
  assert.equal(calls, 2);
  assert.deepEqual(events.map(event => event.stage), ["http", "response"]);
});

test("fails after at most two attempts and logs only finite fields, without credentials or payloads", async () => {
  for (const mode of ["network", "http"]) {
    let calls = 0;
    const { promise, events } = run(async () => {
      calls++;
      if (mode === "network") throw new Error(`private transport ${KEY}`);
      return new Response(`private backend ${KEY}`, { status: 503 });
    });
    await assert.rejects(promise, error => {
      assert.equal(error.message, MESSAGE);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 2);
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ["attempt", "durationMs", "stage", "status"]);
      assert.equal(Number.isFinite(event.durationMs), true);
      assert.equal(Number.isFinite(event.status), true);
      assert.equal(["network", "http"].includes(event.stage), true);
    }
    assert.equal(JSON.stringify(events).includes(KEY), false);
    assert.equal(JSON.stringify(events).includes("private"), false);
  }
});

for (const mode of ["headers", "body"]) {
  test(`15-second deadline aborts a hanging ${mode} and bounds both attempts`, async () => {
    const timers = [];
    const cleared = [];
    const signals = [];
    const { promise, events } = run(async (_url, init) => {
      signals.push(init.signal);
      if (mode === "headers") return new Promise(() => {});
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("true"));
        // A complete-looking value must still wait for the response to end.
      } }), { headers: { "content-type": "application/json" } });
    }, {
      setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
      clearTimer: timer => cleared.push(timer),
    });
    const rejection = assert.rejects(promise, { message: MESSAGE });
    await setImmediate();
    assert.equal(timers.length, 1);
    timers[0].callback();
    await setImmediate();
    assert.equal(signals[0].aborted, true);
    assert.equal(timers.length, 2);
    timers[1].callback();
    await rejection;
    assert.equal(signals[1].aborted, true);
    assert.deepEqual(timers.map(timer => timer.delay), [TIMEOUT_MS, TIMEOUT_MS]);
    assert.equal(TIMEOUT_MS, 15000);
    assert.deepEqual(cleared, timers);
    assert.deepEqual(events.map(event => [event.stage, event.attempt]), [["timeout", 1], ["timeout", 2]]);
  });
}
