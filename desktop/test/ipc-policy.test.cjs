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
  const run = (origin, argv = ["--umbra-version=0.4.0", "--umbra-app-origin=https%3A%2F%2Fpanel.example"]) => {
    let bridge;
    vm.runInNewContext(script, {
      require: (module) => {
        assert.equal(module, "electron", "Sandbox cannot require local CommonJS files");
        return { contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: {} };
      },
      process: { platform: "win32", versions: { electron: "44.4.5", chrome: "152.0.7977.130" }, argv },
      window: { location: { origin } },
    });
    return bridge;
  };
  assert.equal(run("https://panel.example").version, "0.4.0");
  assert.equal(run("https://panel.example").engine.chromium, "152.0.7977.130");
  assert.equal(run("https://other.example"), undefined);
  const packaged = run("https://umbra.mafiatrafa.com", []);
  assert.equal(typeof packaged.checkProxy, "function");
  assert.equal(typeof packaged.launchProfile, "function");
  assert.equal(typeof packaged.listCookieRecoveryBackups, "function");
  assert.match(fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8"),
    /const DEFAULT_APP_URL = "https:\/\/umbra\.mafiatrafa\.com\/app"/);
  assert.equal(run("https://proxy-pals-hub.lovable.app", []), undefined);
  assert.equal(run("https://umbra.mafiatrafa.com.attacker.test", []), undefined);
  assert.equal(run("https://other.example", []), undefined);
});

test("packaged configuration ignores environment overrides and trusts only the new origin", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8");
  const start = main.indexOf("const DEFAULT_APP_URL = ");
  const end = main.indexOf("app.enableSandbox();", start);
  assert(start >= 0 && end > start);
  const context = { app: { isPackaged: true }, process: { env: { UMBRA_APP_URL: "https://proxy-pals-hub.lovable.app/app" } }, isWebUrl, URL };
  vm.runInNewContext(main.slice(start, end) + "\nglobalThis.configured = { APP_URL, APP_ORIGIN };", context);
  assert.equal(context.configured.APP_URL, "https://umbra.mafiatrafa.com/app");
  const frame = { url: context.configured.APP_URL };
  const wc = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: wc };
  assert.equal(isTrustedSender({ sender: wc, senderFrame: frame }, window, context.configured.APP_ORIGIN), true);
  for (const url of ["https://proxy-pals-hub.lovable.app/app", "https://umbra.mafiatrafa.com.attacker.test/app", "https://umbra.mafiatrafa.com@attacker.test/app", "http://umbra.mafiatrafa.com/app", "file:///app"]) {
    frame.url = url;
    assert.equal(isTrustedSender({ sender: wc, senderFrame: frame }, window, context.configured.APP_ORIGIN), false);
  }
  frame.url = context.configured.APP_URL;
  assert.equal(isTrustedSender({ sender: wc, senderFrame: { url: frame.url } }, window, context.configured.APP_ORIGIN), false);
  assert.equal(isTrustedSender({ sender: {}, senderFrame: frame }, window, context.configured.APP_ORIGIN), false);
});
