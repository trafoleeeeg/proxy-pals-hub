const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { normalizeFingerprint, applyNativeScreenMetrics, applyNativeHardwareMetrics, applyFingerprint, userAgentOverride, applyLocale, installSessionPrivacy } = require("../runtime/fingerprint.cjs");

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CHROME = "150.0.1234.56";
const fingerprint = (extra = {}) => normalizeFingerprint({ userAgent: WINDOWS_UA, ...extra }, undefined, CHROME);

test("renderer-wide locale conflicts require a verified match, never silently degrade", async () => {
  for (const value of [true, false, undefined]) {
    const send = async (method, args, id) => {
      assert.equal(id, "worker-session");
      if (method === "Emulation.setLocaleOverride") throw new Error("Locale already owned");
      assert.equal(method, "Runtime.evaluate");
      assert.match(args.expression, /fr-CA/);
      return { result: { value } };
    };
    if (value === true) await applyLocale(send, "fr-CA", "worker-session");
    else await assert.rejects(applyLocale(send, "fr-CA", "worker-session"), /Locale already owned/);
  }
});

test("revoked worker protection blocks requests independently of the proxy request gate", () => {
  let listener;
  let active = true;
  const ses = { webRequest: { onBeforeSendHeaders: (handler) => { listener = handler; } } };
  installSessionPrivacy(ses, fingerprint(), () => active);
  const request = () => {
    let response;
    listener({ url: "https://example.test/", requestHeaders: {} }, (value) => { response = value; });
    return response;
  };
  assert.equal(request().requestHeaders["User-Agent"], fingerprint().userAgent);
  active = false;
  assert.deepEqual(request(), { cancel: true });
});

test("Windows UA and client hints match the actual Chromium runtime", () => {
  const fp = fingerprint();
  const override = userAgentOverride(fp);
  assert.match(fp.userAgent, /Windows NT 10\.0; Win64; x64/);
  assert.match(fp.userAgent, /Chrome\/150\.0\.0\.0/);
  assert.equal(fp.platform, "Win32");
  assert.equal(override.userAgentMetadata.platform, "Windows");
  assert.equal(override.userAgentMetadata.platformVersion, "13.0.0");
  assert.equal(override.userAgentMetadata.architecture, "x86");
  assert.equal(override.userAgentMetadata.fullVersion, CHROME);
});

test("legacy Windows version labels stay launchable with canonical safe versions", () => {
  const windows10UA = WINDOWS_UA.replace("Windows NT 11.0", "Windows NT 10.0");
  for (const osVersion of ["Windows 10", "10.0", "10.0.19045", "legacy-custom-value", "", "15.0\r\n"]) {
    const fp = fingerprint({ userAgent: windows10UA, osVersion });
    assert.equal(fp.osVersion, "10.0.0");
    assert.equal(userAgentOverride(fp).userAgentMetadata.platformVersion, "10.0.0");
  }
  for (const osVersion of ["Windows 11", "windows 11", "11.0", "11.0.22631"]) {
    const fp = fingerprint({ userAgent: windows10UA, osVersion });
    assert.equal(fp.osVersion, "11.0.0");
    assert.equal(userAgentOverride(fp).userAgentMetadata.platformVersion, "13.0.0");
  }
  assert.equal(fingerprint({ osVersion: "legacy-custom-value" }).osVersion, "11.0.0", "legacy NT 11 UA still selects Windows 11");
});

test("new macOS identities still require numeric OS versions", () => {
  for (const osVersion of ["macOS 15", "legacy-custom-value", "", "15.0\r\n"]) {
    assert.throws(() => fingerprint({ os: "macos", osVersion }), /Invalid fingerprint operating system version/);
  }
});

test("macOS uses a frozen Intel legacy UA and explicit Apple Silicon client hints", () => {
  const fp = fingerprint({ os: "macos", osVersion: "15.1", architecture: "arm", platform: "MacIntel" });
  const override = userAgentOverride(fp);
  assert.match(fp.userAgent, /Macintosh; Intel Mac OS X 10_15_7/);
  assert.doesNotMatch(fp.userAgent, /Windows|ARM/);
  assert.equal(fp.platform, "MacIntel");
  assert.equal(override.userAgentMetadata.platform, "macOS");
  assert.equal(override.userAgentMetadata.platformVersion, "15.1.0");
  assert.equal(override.userAgentMetadata.architecture, "arm");
  assert.equal(override.userAgentMetadata.bitness, "64");
  assert.equal(override.userAgentMetadata.fullVersion, CHROME);
});

test("legacy Mac fingerprints are inferred and Intel variants remain supported", () => {
  const fp = fingerprint({ userAgent: WINDOWS_UA.replace("Windows NT 11.0; Win64; x64", "Macintosh; Intel Mac OS X 13_0"), architecture: "x86", osVersion: "13.0.0" });
  assert.equal(fp.os, "macos");
  assert.equal(userAgentOverride(fp).userAgentMetadata.architecture, "x86");
  assert.equal(userAgentOverride(fp).userAgentMetadata.platformVersion, "13.0.0");
});

test("memory stays within Chromium buckets and invalid identity fields fail closed", () => {
  assert.equal(fingerprint({ deviceMemory: 0.25 }).deviceMemory, 0.25);
  assert.equal(fingerprint({ deviceMemory: 0.5 }).deviceMemory, 0.5);
  assert.equal(fingerprint({ deviceMemory: 32 }).deviceMemory, 8);
  assert.equal(fingerprint({ deviceMemory: 6 }).deviceMemory, 4);
  for (const input of [{ os: "unknown" }, { os: "macos", osVersion: "15.0\r\n" }, { architecture: "bad" }, { deviceMemory: 0 }]) {
    assert.throws(() => fingerprint(input), /Invalid fingerprint/);
  }
});

test("Windows canonical identity removes conflicting legacy tokens and honors the primary locale", () => {
  const fp = fingerprint({ os: "windows", osVersion: "11.0.0", userAgent: "Firefox/999 Electron/20 Chrome/99.1.2.3", chromeVersion: "999.9.9.9",
    language: "fr-ca", languages: ["en-us", "fr-CA", "en-US"] });
  assert.equal(fp.userAgent, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
  assert.deepEqual(fp.languages, ["fr-CA", "en-US"]);
  const metadata = userAgentOverride(fp).userAgentMetadata;
  assert.equal(metadata.fullVersion, CHROME);
  assert.equal(metadata.platformVersion, "13.0.0");
  assert.equal(metadata.mobile, false);
  assert.equal(metadata.model, "");
  assert.equal(userAgentOverride(fingerprint({ osVersion: "10.0" })).userAgentMetadata.platformVersion, "10.0.0");
});

test("legacy profiles retain strict API blocking while new normal-mode profiles opt out explicitly", () => {
  assert.equal(fingerprint().aggressivePrivacyMode, true, "a missing field must preserve legacy protection");
  assert.equal(fingerprint({ aggressivePrivacyMode: true }).aggressivePrivacyMode, true);
  assert.equal(fingerprint({ aggressivePrivacyMode: false }).aggressivePrivacyMode, false);
  for (const value of [null, 0, 1, "false", "true", {}, []]) {
    assert.throws(() => fingerprint({ aggressivePrivacyMode: value }), /Invalid fingerprint/);
  }
});

function webContents({ policy = "disable_non_proxied_udp", reject = null } = {}) {
  const commands = [];
  let detached = false;
  return {
    commands, get detached() { return detached; },
    setUserAgent() {}, setWebRTCIPHandlingPolicy() {}, getWebRTCIPHandlingPolicy: () => policy,
    debugger: {
      attach() {}, isAttached: () => !detached, detach() { detached = true; },
      async sendCommand(command, args) {
        commands.push({ command, args });
        if (command === reject) throw new Error("Protocol error");
      },
    },
  };
}

test("native screen CSS and hardware concurrency preserve viewport size but mask host DPI", async () => {
  const wc = webContents();
  const fp = fingerprint({ hardwareConcurrency: 12, screen: { width: 1512, height: 982 } });
  const diagnostics = await applyFingerprint(wc, fp);
  assert.deepEqual(wc.commands.find((item) => item.command === "Emulation.setHardwareConcurrencyOverride").args, { hardwareConcurrency: 12 });
  assert.deepEqual(wc.commands.find((item) => item.command === "Emulation.setDeviceMetricsOverride").args, {
    width: 0, height: 0, deviceScaleFactor: 1, mobile: false, screenWidth: 1512, screenHeight: 982,
  });
  assert.equal(diagnostics.screenMetrics, "cdp-top-level-and-js-only-oopif");
  assert.ok(diagnostics.limitations.some((item) => item.includes("Shared/service workers")));
});

test("native session screen metrics are applied before navigation and stock packaged engines fail closed", async () => {
  const windows = fingerprint({ screen: { width: 1733, height: 977, colorDepth: 24 } });
  assert.equal(applyNativeScreenMetrics({}, windows), false);
  assert.equal(windows.nativeScreenMetrics, undefined);
  assert.throws(() => applyNativeScreenMetrics({}, windows, { required: true }), /Native screen protection is unavailable/);
  const calls = [];
  assert.equal(applyNativeScreenMetrics({ setUmbraScreenMetrics: (metrics) => calls.push(metrics) }, windows, { required: true }), true);
  assert.deepEqual(calls, [{ width: 1733, height: 977, availableWidth: 1733, availableHeight: 937, colorDepth: 24, deviceScaleFactor: 1 }]);
  assert.equal(windows.nativeScreenMetrics, true);
  const wc = webContents();
  const diagnostics = await applyFingerprint(wc, windows);
  assert.equal(diagnostics.screenMetrics, "native-session-css-and-javascript");
  assert.equal(wc.commands.some((item) => item.command === "Emulation.setDeviceMetricsOverride"), false);
  const mac = fingerprint({ os: "macos", osVersion: "15.0.0", screen: { width: 1512, height: 982 } });
  applyNativeScreenMetrics({ setUmbraScreenMetrics: (metrics) => calls.push(metrics) }, mac);
  assert.deepEqual(calls[1], { width: 1512, height: 982, availableWidth: 1512, availableHeight: 957, colorDepth: 24, deviceScaleFactor: 2 });
  assert.throws(() => applyNativeScreenMetrics({ setUmbraScreenMetrics: () => { throw new Error("internal path"); } }, fingerprint()), /Native screen protection could not be applied/);
});

test("native hardware policy fails closed and preserves native getters instead of adding a second override", async () => {
  const fp = fingerprint({ hardwareConcurrency: 3, deviceMemory: 0.5 });
  assert.equal(applyNativeHardwareMetrics({}, fp), false);
  assert.throws(() => applyNativeHardwareMetrics({}, fp, { required: true }), /unavailable/);
  assert.throws(() => applyNativeHardwareMetrics({ setUmbraHardwareMetrics() { throw new Error("private internal path"); } }, fp), /Native hardware reporting could not be applied/);
  assert.equal(fp.nativeHardwareMetrics, undefined);
  let received;
  assert.equal(applyNativeHardwareMetrics({ setUmbraHardwareMetrics(metrics) { received = metrics; } }, fp), true);
  assert.deepEqual(received, { hardwareConcurrency: 3, deviceMemory: 0.5 });
  const wc = webContents({ reject: "Emulation.setHardwareConcurrencyOverride" });
  const report = await applyFingerprint(wc, fp);
  assert.equal(report.hardwareConcurrency, "native-session-renderer");
  assert.equal(wc.commands.some(item => item.command === "Emulation.setHardwareConcurrencyOverride"), false);
  const source = wc.commands.find(item => item.command === "Page.addScriptToEvaluateOnNewDocument").args.source;
  const navigator = {};
  const cores = () => 3;
  const memory = () => 0.5;
  Object.defineProperty(navigator, "hardwareConcurrency", { get: cores });
  Object.defineProperty(navigator, "deviceMemory", { get: memory });
  vm.runInContext(source, vm.createContext({ navigator, screen: {} }));
  assert.equal(Object.getOwnPropertyDescriptor(navigator, "hardwareConcurrency").get, cores);
  assert.equal(Object.getOwnPropertyDescriptor(navigator, "deviceMemory").get, memory);
});

test("unsafe native WebRTC policy or failed CDP protection prevents navigation setup", async () => {
  await assert.rejects(applyFingerprint(webContents({ policy: "default" }), fingerprint()), /Unable to apply fingerprint WebRTC policy/);
  const wc = webContents({ reject: "Emulation.setHardwareConcurrencyOverride" });
  await assert.rejects(applyFingerprint(wc, fingerprint()), /Unable to apply fingerprint before navigation/);
  assert.equal(wc.detached, true);
});

test("document privacy hides attached media-device identities and supports macOS work area", async () => {
  const wc = webContents();
  await applyFingerprint(wc, fingerprint({ os: "macos", webrtc: "disabled", screen: { width: 1512, height: 982 } }));
  const source = wc.commands.find((item) => item.command === "Page.addScriptToEvaluateOnNewDocument").args.source;
  const context = vm.createContext({ navigator: { mediaDevices: { enumerateDevices: async () => [{ deviceId: "physical-device" }] } }, screen: {}, RTCPeerConnection: class {} });
  vm.runInContext(source, context);
  assert.equal((await context.navigator.mediaDevices.enumerateDevices()).length, 0);
  assert.equal(context.screen.availHeight, 957);
  assert.equal(context.RTCPeerConnection, undefined);
});

test("document script blocks hardware APIs only in strict mode", async () => {
  async function probe(aggressivePrivacyMode) {
    const wc = webContents();
    await applyFingerprint(wc, fingerprint({ aggressivePrivacyMode }));
    const source = wc.commands.find((item) => item.command === "Page.addScriptToEvaluateOnNewDocument").args.source;
    class CanvasContext {
      getImageData() { return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; }
    }
    class Canvas {
      getContext(type) { return type === "webgl" ? {} : new CanvasContext(); }
    }
    const context = vm.createContext({
      origin: "https://example.test", navigator: { serviceWorker: {} }, screen: {},
      HTMLCanvasElement: Canvas, CanvasRenderingContext2D: CanvasContext,
      AudioContext: class {}, SharedWorker: class {}, DOMException,
    });
    vm.runInContext(source, context);
    let canvasBlocked = false;
    try { new context.CanvasRenderingContext2D().getImageData(0, 0, 1, 1); }
    catch (error) { canvasBlocked = error.name === "SecurityError"; }
    return {
      gpuBlocked: new context.HTMLCanvasElement().getContext("webgl") === null,
      canvasBlocked,
      audioBlocked: context.AudioContext === undefined,
      sharedBlocked: context.SharedWorker === undefined,
      serviceBlocked: context.navigator.serviceWorker === undefined,
    };
  }
  assert.deepEqual(await probe(true), { gpuBlocked: true, canvasBlocked: true, audioBlocked: true, sharedBlocked: true, serviceBlocked: true });
  assert.deepEqual(await probe(false), { gpuBlocked: false, canvasBlocked: false, audioBlocked: false, sharedBlocked: false, serviceBlocked: false });
});
