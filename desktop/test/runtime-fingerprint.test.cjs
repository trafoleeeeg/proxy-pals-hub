const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { normalizeFingerprint, applyNativeScreenMetrics, applyNativeHardwareMetrics, prepareFingerprintTarget, applyFingerprint, userAgentOverride, applyLocale, installSessionPrivacy } = require("../runtime/fingerprint.cjs");

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CHROME = "150.0.1234.56";
const fingerprint = (extra = {}) => normalizeFingerprint({ userAgent: WINDOWS_UA, ...extra }, undefined, CHROME);

test("protection trace includes begin/end metadata and cannot alter protection when it throws", async () => {
  const trace = [];
  const wc = webContents();
  await applyFingerprint(wc, fingerprint(), { onTrace: row => trace.push(row) });
  assert.ok(trace.some(row => row.stage === "blank-init" && row.phase === "begin"));
  assert.ok(trace.some(row => row.stage === "Page.addScriptToEvaluateOnNewDocument" && row.phase === "done" && row.elapsedMs >= 0));
  for (const { command } of wc.commands) {
    assert.ok(trace.some(row => row.stage === command && row.phase === "begin"));
    assert.ok(trace.some(row => row.stage === command && row.phase === "done"));
  }
  assert.ok(trace.every(row => !Object.hasOwn(row, "params") && !Object.hasOwn(row, "response")));
  await applyFingerprint(webContents(), fingerprint(), { onTrace: () => { throw new Error("Disk full"); } });
});

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

function webContents({ policy = "disable_non_proxied_udp", reject = null, announceContext = true, namedWorkerContext = false } = {}) {
  const commands = [];
  let detached = false;
  return {
    commands, get detached() { return detached; },
    setUserAgent() {}, setWebRTCIPHandlingPolicy() {}, getWebRTCIPHandlingPolicy: () => policy,
    debugger: Object.assign(new (require("node:events").EventEmitter)(), {
      attach() {}, isAttached: () => !detached, detach() { detached = true; },
      async sendCommand(command, args, id) {
        commands.push({ command, args, id });
        if (command === reject) throw new Error("Protocol error");
        if (command === "Runtime.enable" && announceContext) this.emit("message", {}, "Runtime.executionContextCreated", {
          context: { id: 1, uniqueId: "unique-" + (id || "root"), name: id && namedWorkerContext ? "site-assigned-worker-name" : "",
            ...(id && namedWorkerContext ? {} : { auxData: { isDefault: true, frameId: "frame-" + (id || "root") } }) },
        }, id);
        if (command === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-" + (id || "root") } } };
        if (command === "Runtime.evaluate") return { result: { value: true } };
      },
    }),
  };
}

test("a fresh blank renderer must finish local initialization before any debugger attachment", async () => {
  const wc = webContents();
  let ready = false, release;
  const loading = new Promise(resolve => { release = () => { ready = true; resolve(); }; });
  wc.getURL = () => ready ? "about:blank" : "";
  wc.isLoading = () => !ready;
  wc.loadURL = url => { assert.equal(url, "about:blank"); return loading; };
  let attached = false;
  wc.debugger.attach = () => { assert.equal(ready, true); attached = true; };
  const pending = applyFingerprint(wc, fingerprint());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attached, false);
  assert.equal(wc.commands.length, 0);
  release(); await pending;
  assert.equal(attached, true);
});

test("local initialization is bounded and cannot attach after cancellation", async () => {
  const wc = webContents();
  wc.getURL = () => "";
  wc.isLoading = () => false;
  wc.loadURL = () => new Promise(() => {});
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(prepareFingerprintTarget(wc, { timeout: 20 }), /timed out/); }
  finally { clearTimeout(keepAlive); }
  let release, closing = false;
  wc.loadURL = () => new Promise(resolve => { release = resolve; });
  const pending = applyFingerprint(wc, fingerprint(), { isClosing: () => closing });
  closing = true; release();
  await assert.rejects(pending, /closing/);
  assert.equal(wc.commands.length, 0);
  assert.equal(wc.detached, false);
});

test("locale verification waits for the real main-world context instead of evaluating a provisional frame", async () => {
  const wc = webContents({ reject: "Emulation.setLocaleOverride", announceContext: false });
  const pending = applyFingerprint(wc, fingerprint());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wc.commands.some(c => c.command === "Runtime.evaluate"), false);
  wc.debugger.emit("message", {}, "Runtime.executionContextCreated", { context: {
    id: 7, uniqueId: "isolated-world", name: "", auxData: { isDefault: false, frameId: "frame-root" },
  } });
  wc.debugger.emit("message", {}, "Runtime.executionContextCreated", { context: {
    id: 8, uniqueId: "different-frame", name: "", auxData: { isDefault: true, frameId: "frame-child" },
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wc.commands.some(c => c.command === "Runtime.evaluate"), false);
  wc.debugger.emit("message", {}, "Runtime.executionContextCreated", { context: {
    id: 9, uniqueId: "ready-main-world", name: "", auxData: { isDefault: true, frameId: "frame-root" },
  } });
  await pending;
  assert.equal(wc.commands.find(c => c.command === "Runtime.evaluate").args.uniqueContextId, "ready-main-world");
});

test("child locale and worker evaluations use their own unique contexts, not the parent default world", async () => {
  const wc = webContents({ reject: "Emulation.setLocaleOverride" });
  await applyFingerprint(wc, fingerprint());
  for (const type of ["iframe", "page", "worker"]) {
    wc.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: type, targetInfo: { type }, waitingForDebugger: true });
    await new Promise(resolve => setImmediate(resolve));
    const evaluations = wc.commands.filter(c => c.command === "Runtime.evaluate" && c.id === type);
    assert.ok(evaluations.length > 0);
    assert.ok(evaluations.every(c => c.args.uniqueContextId === "unique-" + type));
    assert.ok(wc.commands.some(c => c.command === "Runtime.runIfWaitingForDebugger" && c.id === type));
  }
});

test("a named dedicated worker is protected in its announced context before resuming", async () => {
  const wc = webContents({ namedWorkerContext: true });
  const failures = [], contexts = [];
  await applyFingerprint(wc, fingerprint(), { onFailure: row => failures.push(row), onContextTrace: row => contexts.push(row) });
  wc.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: "named", targetInfo: { type: "worker" }, waitingForDebugger: true });
  await new Promise(resolve => setImmediate(resolve));
  const evaluationIndex = wc.commands.findIndex(row => row.command === "Runtime.evaluate" && row.id === "named");
  const resumeIndex = wc.commands.findIndex(row => row.command === "Runtime.runIfWaitingForDebugger" && row.id === "named");
  assert.ok(evaluationIndex >= 0 && resumeIndex > evaluationIndex);
  assert.equal(wc.commands[evaluationIndex].args.uniqueContextId, "unique-named");
  assert.deepEqual(failures, []);
  assert.ok(contexts.some(row => row.targetType === "worker" && row.named && row.accepted));
  assert.doesNotMatch(JSON.stringify(contexts), /site-assigned-worker-name|unique-named/);
});

test("closing the debugger while locale waits never sends a default-context evaluation", async () => {
  const wc = webContents({ reject: "Emulation.setLocaleOverride", announceContext: false });
  const pending = applyFingerprint(wc, fingerprint());
  await new Promise(resolve => setImmediate(resolve));
  wc.debugger.emit("detach", {}, "target closed");
  await assert.rejects(pending, /Unable to apply fingerprint before navigation/);
  assert.equal(wc.commands.some(c => c.command === "Runtime.evaluate"), false);
});

test("page diagnostics report the rejected command even when the callback throws", async () => {
  const wc = webContents({ reject: "Emulation.setHardwareConcurrencyOverride" });
  const details = [];
  await assert.rejects(applyFingerprint(wc, fingerprint(), { onDiagnostic: value => { details.push(value); throw new Error("ignored"); } }), /Unable to apply fingerprint before navigation/);
  assert.deepEqual(details, [{ reason: "setup-failed", stage: "Emulation.setHardwareConcurrencyOverride", targetType: "page" }]);
  assert.equal(wc.detached, true);
});

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

test("closed or crashed renderer targets preserve other tabs; unexpected debugger loss still fails closed", async () => {
  for (const reason of ["target closed", "render process gone", "replaced with devtools"]) {
    const wc = webContents();
    let blocked = 0, failures = 0;
    wc.session = { webRequest: { onBeforeRequest() { blocked++; } }, closeAllConnections: async () => {} };
    wc.stop = () => {};
    await applyFingerprint(wc, fingerprint(), { onFailure: () => { failures++; } });
    wc.debugger.emit("detach", {}, reason);
    const expectedFailure = reason === "replaced with devtools" ? 1 : 0;
    assert.equal(blocked, expectedFailure);
    assert.equal(failures, expectedFailure);
  }
});

test("closing a tab during CDP setup never accesses its destroyed native debugger", async () => {
  for (const destroyed of [false, true]) {
    const wc = webContents();
    const debug = wc.debugger;
    let closing = false, release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const firstCommand = new Promise(resolve => { started = resolve; });
    debug.sendCommand = async command => {
      wc.commands.push({ command });
      assert.equal(command, "Target.setAutoAttach", "no later CDP calls after close");
      started();
      await gate;
    };
    wc.isDestroyed = () => destroyed && closing;
    Object.defineProperty(wc, "debugger", { get() {
      assert.equal(wc.isDestroyed(), false, "destroyed debugger getter would crash native Electron");
      return debug;
    } });
    const pending = applyFingerprint(wc, fingerprint(), { isClosing: () => closing });
    await firstCommand;
    closing = true;
    release();
    await assert.rejects(pending, /Unable to apply fingerprint before navigation/);
    assert.equal(wc.commands.length, 1);
    assert.equal(wc.detached, !destroyed);
  }
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

test("allowed rendering APIs preserve native methods despite legacy noise and GPU fields", async () => {
  for (const aggressivePrivacyMode of [false, true]) {
    for (const worker of [false, true]) {
      const wc = webContents();
      const fp = fingerprint({ aggressivePrivacyMode, canvasNoise: 17491, audioNoise: 27491,
        gpu: { vendor: "legacy vendor", renderer: "legacy renderer" } });
      fp.hardwarePermissions = { "https://example.test": ["gpu", "canvas", "audio", "fonts", "workers"] };
      const report = await applyFingerprint(wc, fp);
      assert.equal(report.gpuIdentity, "native-when-allowed-not-emulated");
      assert.ok(report.unsupportedControls.includes("canvasNoise"));
      const source = wc.commands.find(item => item.command === "Page.addScriptToEvaluateOnNewDocument").args.source;
      class GL { getParameter() { return "native-test-renderer"; } }
      class CanvasContext { getImageData() { return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; } }
      class Canvas { getContext() { return new CanvasContext(); } toDataURL() { return "data:,"; } toBlob() {} convertToBlob() {} }
      class AudioBuffer { getChannelData() {} copyFromChannel() {} copyToChannel() {} }
      class AnalyserNode { getFloatFrequencyData() {} getFloatTimeDomainData() {} }
      const methods = [[GL.prototype, "getParameter"], [CanvasContext.prototype, "getImageData"],
        [Canvas.prototype, "getContext"], [Canvas.prototype, "toDataURL"], [Canvas.prototype, "toBlob"],
        [Canvas.prototype, "convertToBlob"], [AudioBuffer.prototype, "getChannelData"],
        [AudioBuffer.prototype, "copyFromChannel"], [AudioBuffer.prototype, "copyToChannel"],
        [AnalyserNode.prototype, "getFloatFrequencyData"], [AnalyserNode.prototype, "getFloatTimeDomainData"]];
      const before = methods.map(([object, key]) => object[key]);
      const context = vm.createContext({ origin: "https://example.test", navigator: {}, screen: {},
        ...(!worker ? { HTMLCanvasElement: Canvas, CanvasRenderingContext2D: CanvasContext } : {}),
        OffscreenCanvas: Canvas, OffscreenCanvasRenderingContext2D: CanvasContext,
        WebGLRenderingContext: GL, WebGL2RenderingContext: GL, AudioBuffer, AnalyserNode });
      vm.runInContext(source, context);
      methods.forEach(([object, key], index) => assert.equal(object[key], before[index], `${key}: native implementation must remain unchanged`));
    }
  }
});
