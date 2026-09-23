const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { isTrustedSender, isWebUrl } = require("../ipc-policy.cjs");
test("only the trusted main window's top frame can invoke privileged IPC", () => {
  const frame = { url: "https://panel.example/app" };
  const wc = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: wc };
  assert.equal(isTrustedSender({ sender: wc, senderFrame: frame }, window, "https://panel.example"), true);
  assert.equal(isTrustedSender({ sender: wc, senderFrame: { ...frame } }, window, "https://panel.example"), false);
  assert.equal(isTrustedSender({ sender: {}, senderFrame: frame }, window, "https://panel.example"), false);
  frame.url = "https://panel.example.attacker.test/";
  assert.equal(isTrustedSender({ sender: wc, senderFrame: frame }, window, "https://panel.example"), false);
});
test("external URL policy rejects executable protocols and embedded credentials", () => {
  for (const value of ["file:///C:/Windows/", "javascript:alert(1)", "https://u:p@example.com", "invalid"]) assert.equal(isWebUrl(value), false);
  assert.equal(isWebUrl("https://example.com/page"), true);
});
test("sandboxed preload loads without requiring package.json and exposes no bridge to other origins", () => {
  const script = fs.readFileSync(path.join(__dirname, "../preload.cjs"), "utf8");
  const run = (origin) => {
    let bridge;
    vm.runInNewContext(script, {
      require: (module) => {
        assert.equal(module, "electron", "Sandbox cannot require local CommonJS files");
        return { contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: {} };
      },
      process: { platform: "win32", versions: { electron: "44.4.5", chrome: "152.0.7977.130" }, argv: ["--umbra-version=0.4.0", "--umbra-app-origin=https%3A%2F%2Fpanel.example"] },
      window: { location: { origin } },
    });
    return bridge;
  };
  assert.equal(run("https://panel.example").version, "0.4.0");
  assert.equal(run("https://panel.example").engine.chromium, "152.0.7977.130");
  assert.equal(run("https://other.example"), undefined);
});
