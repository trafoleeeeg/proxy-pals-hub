const test = require("node:test");
const { runNativeHarness } = require("./runtime-electron.test.cjs");

// Runs browser/proxy/session integration even on service accounts without DPAPI.
// OS encryption is verified separately by runtime-electron.test.cjs.
test("native Electron HTTP/SOCKS5 authentication and fail-closed network", { timeout: 90000 }, (t) => runNativeHarness(t, "network"));
test("native Electron fingerprint and toolbar (memory cookie store; no DPAPI coverage)", { timeout: 90000 }, (t) => runNativeHarness(t, "memory"));
