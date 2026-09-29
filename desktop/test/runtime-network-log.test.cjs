const test = require("node:test");
const assert = require("node:assert/strict");
const { resolverActivity } = require("./runtime-network-advanced.cjs");
const constants = { logEventTypes: { HOST_RESOLVER_MANAGER_REQUEST: 1, HOST_RESOLVER_MANAGER_TASK_SEQUENCE_CREATED: 2, HOST_RESOLVER_MANAGER_REQUEST_BOUND_TO_JOB: 3, DNS_TRANSACTION: 4 } };
const event = (type, params, phase = 0) => ({ type, params, phase, source: { id: 0, type: 1 } });
const begin = name => event(1, { host: `http://${name}:80` }, 1);
const end = () => event(1, {}, 2);
test("DNS audit distinguishes local cache/hosts lookups from network tasks", () => {
  const local = resolverActivity({ constants, events: [begin("site.invalid"), event(2, { tasks: [4, 9] }), end()] }, ["site.invalid"]);
  assert.deepEqual(local, { requests: 1, tasks: [4, 9], network: [] });
  for (const task of [0, 1, 2, 3, 8, 10, 999]) {
    assert.ok(resolverActivity({ constants, events: [begin("site.invalid"), event(2, { tasks: [4, task] }), end()] }, ["site.invalid"]).network.length > 0);
  }
  assert.ok(resolverActivity({ constants, events: [begin("site.invalid"), event(3, {}), end()] }, ["site.invalid"]).network.length > 0);
  assert.ok(resolverActivity({ constants, events: [event(4, { hostname: "site.invalid" })] }, ["site.invalid"]).network.length > 0);
});
test("DNS audit scopes reused source IDs and ignores names in isolation keys", () => {
  const events = [begin("site.invalid"), event(2, { tasks: [4, 9] }), end(), begin("control.localhost"), event(2, { tasks: [0] }), end(), event(1, { host: "http://127.0.0.1", network_anonymization_key: "site.invalid" }, 1), end()];
  assert.deepEqual(resolverActivity({ constants, events }, ["site.invalid"]).network, []);
});
