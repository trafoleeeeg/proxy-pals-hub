const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRuntimeProxy } = require("../runtime/proxy.cjs");

test("proxy worker terminates before stalled Chromium connections finish closing", async () => {
  let worker;
  class Worker extends EventEmitter {
    constructor() {
      super();
      worker = this;
      this.stdout = { resume() {} };
      this.stderr = { resume() {} };
      setImmediate(() => this.emit("message", { type: "ready", port: 43210 }));
    }
    async terminate() { this.terminated = true; }
  }
  const ses = {
    webRequest: { onBeforeRequest(handler) { this.handler = handler; } },
    closeAllConnections: async () => {},
    setProxy: async () => {},
  };
  const proxy = await createRuntimeProxy(ses, { protocol: "http", host: "proxy.example", port: 8080, username: "fixture", password: "fixture" }, { WorkerClass: Worker });
  let finish;
  ses.closeAllConnections = () => new Promise((resolve) => { finish = resolve; });
  const closing = proxy.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.terminated, true);
  assert.equal(typeof ses.webRequest.handler, "function", "session network remains blocked");
  finish();
  await closing;
});
