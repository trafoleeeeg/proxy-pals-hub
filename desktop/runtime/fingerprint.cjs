const fs = require("node:fs");
const path = require("node:path");
const DOCUMENT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "fingerprint-preload.cjs"), "utf8");
const WEBRTC_POLICY = "disable_non_proxied_udp";

function hasCapability(fp, origin, capability) {
  if (!origin || origin === "null") return false;
  if (fp.aggressivePrivacyMode === false) return true;
  if (fp.hardwarePermissions) return fp.hardwarePermissions[origin]?.includes(capability) === true;
  return fp.hardwareOrigins?.includes(origin) === true; // Legacy local policy.
}

function installSessionPrivacy(ses, fp, canSend = () => true) {
  const identity = userAgentOverride(fp);
  const meta = identity.userAgentMetadata;
  const quoted = (value) => JSON.stringify(String(value));
  const brands = (items) => items.map((item) => `${quoted(item.brand)};v=${quoted(item.version)}`).join(", ");
  const hints = meta ? {
    "sec-ch-ua": brands(meta.brands), "sec-ch-ua-full-version-list": brands(meta.fullVersionList),
    "sec-ch-ua-full-version": quoted(meta.fullVersion), "sec-ch-ua-platform": quoted(meta.platform),
    "sec-ch-ua-platform-version": quoted(meta.platformVersion), "sec-ch-ua-arch": quoted(meta.architecture),
    "sec-ch-ua-bitness": quoted(meta.bitness), "sec-ch-ua-model": '""', "sec-ch-ua-mobile": "?0", "sec-ch-ua-wow64": "?0",
  } : {};
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!canSend()) { callback({ cancel: true }); return; }
    const headers = { ...details.requestHeaders };
    const offeredHints = [];
    const memoryHints = new Set();
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "service-worker") {
        let origin; try { origin = new URL(details.url).origin; } catch { /* deny below */ }
        if (!hasCapability(fp, origin, "workers")) { callback({ cancel: true }); return; }
      }
      if (lower.startsWith("sec-ch-ua")) { offeredHints.push(lower); delete headers[key]; }
      // Both current and deprecated memory hints otherwise report the host's
      // RAM from the browser process, independently of navigator.deviceMemory.
      if (["device-memory", "sec-ch-device-memory"].includes(lower)) { memoryHints.add(lower); delete headers[key]; }
      if (["user-agent", "accept-language", "dnt"].includes(lower)) delete headers[key];
    }
    headers["User-Agent"] = fp.userAgent;
    headers["Accept-Language"] = fp.languages.map((language, i) => i ? `${language};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}` : language).join(",");
    if (fp.doNotTrack) headers.DNT = "1";
    for (const key of offeredHints) if (hints[key]) headers[key] = hints[key];
    for (const key of memoryHints) headers[key] = String(fp.deviceMemory);
    callback({ requestHeaders: headers });
  });
}

function normalizeFingerprint(raw = {}, defaultUA, runtimeChrome = process.versions.chrome) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid fingerprint");
  // Profiles created before the mode existed retain the previous strict policy.
  const aggressivePrivacyMode = raw.aggressivePrivacyMode === undefined ? true : raw.aggressivePrivacyMode;
  if (typeof aggressivePrivacyMode !== "boolean") throw new Error("Invalid fingerprint privacy mode");
  const integer = (value, fallback, min, max) => {
    if (value == null) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid fingerprint dimensions");
    return value;
  };
  let userAgent = raw.userAgent ?? raw.user_agent ?? defaultUA;
  if (typeof userAgent !== "string" || !userAgent || userAgent.length > 1024 || /[\r\n\0]/.test(userAgent)) throw new Error("Invalid user agent");
  const os = raw.os ?? (raw.platform === "MacIntel" || /Macintosh/.test(userAgent) ? "macos" : "windows");
  if (!["windows", "macos"].includes(os)) throw new Error("Invalid fingerprint operating system");
  const explicitWindows10 = /^(?:Windows\s+)?10(?:\.|$)/i.test(raw.osVersion || "");
  const windows11 = os === "windows" && !explicitWindows10 && (/^(?:Windows\s+)?11(?:\.|$)/i.test(raw.osVersion || "") || /Windows NT 11/.test(userAgent));
  // Earlier clients accepted arbitrary Windows version labels. Preserve those
  // profiles by deriving a canonical version rather than rejecting old data.
  const osVersion = os === "windows" ? (windows11 ? "11.0.0" : "10.0.0") : (raw.osVersion ?? "14.0.0");
  if (typeof osVersion !== "string" || !/^\d{1,2}(?:\.\d{1,3}){0,2}$/.test(osVersion)) throw new Error("Invalid fingerprint operating system version");
  const architecture = raw.architecture ?? (os === "macos" ? "arm" : "x86");
  if (!["arm", "x86"].includes(architecture)) throw new Error("Invalid fingerprint architecture");
  // Chrome freezes the legacy macOS UA at 10_15_7 even on Apple Silicon;
  // actual OS version and architecture belong in high-entropy client hints.
  const osToken = os === "macos" ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64";
  userAgent = userAgent.replace(/\((?:Windows NT|Macintosh)[^)]*\)/, `(${osToken})`);
  if (runtimeChrome) userAgent = userAgent.replace(/Chrome\/[\d.]+/g, `Chrome/${runtimeChrome}`);
  const chromeVersion = runtimeChrome || raw.chromeVersion || raw.chrome_version || /Chrome\/([\d.]+)/.exec(userAgent)?.[1];
  if (os === "windows") {
    if (typeof chromeVersion !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(chromeVersion)) throw new Error("Invalid fingerprint Chromium version");
    // Match Chrome UA reduction; the real full runtime version lives in UA-CH.
    // Never preserve conflicting Firefox/Edge/Electron suffixes from old data.
    userAgent = `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion.split(".")[0]}.0.0.0 Safari/537.36`;
  }
  let languages;
  try { languages = Intl.getCanonicalLocales(raw.language ? [raw.language, ...(raw.languages ?? [])] : (raw.languages ?? ["en-US", "en"])); }
  catch { throw new Error("Invalid fingerprint languages"); }
  if (!languages.length || languages.length > 10) throw new Error("Invalid fingerprint languages");
  const timezone = raw.timezone ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new Error("Invalid fingerprint timezone"); }
  const platform = os === "macos" ? "MacIntel" : "Win32";
  const vendor = raw.gpu?.vendor ?? raw.webgl_vendor;
  const renderer = raw.gpu?.renderer ?? raw.webgl_renderer;
  if ([vendor, renderer].some((value) => value != null && (typeof value !== "string" || value.length > 1024))) throw new Error("Invalid fingerprint GPU");
  const memory = raw.deviceMemory ?? raw.device_memory ?? 8;
  if (typeof memory !== "number" || !Number.isFinite(memory) || memory < 0.25 || memory > 256) throw new Error("Invalid fingerprint memory");
  return {
    userAgent, platform, os, osVersion, architecture, languages, timezone, aggressivePrivacyMode,
    screen: {
      width: integer(raw.screen?.width ?? raw.screen_width, 1280, 320, 16384),
      height: integer(raw.screen?.height ?? raw.screen_height, 800, 200, 16384),
      colorDepth: integer(raw.screen?.colorDepth ?? raw.color_depth, 24, 1, 64),
    },
    hardwareConcurrency: integer(raw.hardwareConcurrency ?? raw.hardware_concurrency, 8, 1, 256),
    // Chromium exposes coarse memory buckets with an 8 GiB upper bound.
    deviceMemory: Math.min(8, 2 ** Math.floor(Math.log2(memory))),
    gpu: { vendor, renderer }, doNotTrack: !!(raw.doNotTrack ?? raw.do_not_track),
    webrtc: raw.webrtc === "disabled" ? "disabled" : "proxy",
    chromeVersion,
    windows11,
    canvasNoise: integer(raw.canvasNoise ?? raw.canvas_noise, 0, 0, 2147483647),
    audioNoise: integer(raw.audioNoise ?? raw.audio_noise, 0, 0, 2147483647),
  };
}

function applyNativeHardwareMetrics(ses, fp, { required = false } = {}) {
  if (typeof ses?.setUmbraHardwareMetrics !== "function") {
    if (required) throw new Error("Native hardware reporting protection is unavailable");
    return false;
  }
  try { ses.setUmbraHardwareMetrics({ hardwareConcurrency: fp.hardwareConcurrency, deviceMemory: fp.deviceMemory }); }
  catch { throw new Error("Native hardware reporting could not be applied; restart Umbra before changing CPU or memory settings"); }
  fp.nativeHardwareMetrics = true;
  return true;
}

function applyNativeScreenMetrics(ses, fp, { required = false } = {}) {
  if (typeof ses?.setUmbraScreenMetrics !== "function") {
    if (required) throw new Error("Native screen protection is unavailable");
    return false;
  }
  const metrics = {
    width: fp.screen.width,
    height: fp.screen.height,
    availableWidth: fp.screen.width,
    availableHeight: Math.max(1, fp.screen.height - (fp.os === "macos" ? 25 : 40)),
    colorDepth: fp.screen.colorDepth,
    deviceScaleFactor: fp.os === "macos" ? 2 : 1,
  };
  try { ses.setUmbraScreenMetrics(metrics); }
  catch { throw new Error("Native screen protection could not be applied; restart Umbra before changing screen settings"); }
  fp.nativeScreenMetrics = true;
  return true;
}

function userAgentOverride(fp) {
  const result = { userAgent: fp.userAgent, acceptLanguage: fp.languages.join(","), platform: fp.platform };
  const match = /Chrome\/(\d+)\.([\d.]+)/.exec(fp.userAgent);
  if (match && ["Win32", "MacIntel"].includes(fp.platform)) {
    const major = match[1];
    const full = typeof fp.chromeVersion === "string" && new RegExp(`^${major}\\.\\d+\\.\\d+\\.\\d+$`).test(fp.chromeVersion) ? fp.chromeVersion : `${major}.${match[2]}`;
    result.userAgentMetadata = {
      brands: [{ brand: "Chromium", version: major }, { brand: "Google Chrome", version: major }, { brand: "Not_A Brand", version: "99" }],
      fullVersionList: [{ brand: "Chromium", version: full }, { brand: "Google Chrome", version: full }, { brand: "Not_A Brand", version: "99.0.0.0" }],
      fullVersion: full, platform: fp.platform === "MacIntel" ? "macOS" : "Windows",
      platformVersion: fp.platform === "MacIntel" ? (fp.osVersion.split(".").concat("0", "0").slice(0, 3).join(".")) : fp.windows11 ? "13.0.0" : "10.0.0",
      architecture: fp.architecture || "x86", bitness: "64", model: "", mobile: false, wow64: false,
    };
  }
  return result;
}

async function applyFingerprint(wc, fp, { onFailure = () => {} } = {}) {
  wc.setUserAgent(fp.userAgent);
  wc.setWebRTCIPHandlingPolicy(WEBRTC_POLICY);
  if (wc.getWebRTCIPHandlingPolicy() !== WEBRTC_POLICY) throw new Error("Unable to apply fingerprint WebRTC policy");
  wc.debugger.attach("1.3");
  const source = `(${DOCUMENT_SOURCE})(${JSON.stringify(fp)});`;
  let stopped = false;
  const children = new Set();
  const fail = () => {
    if (stopped || wc.isDestroyed?.()) return;
    stopped = true;
    // Never leave a running renderer behind when protection disappears.
    wc.session?.webRequest?.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    void wc.session?.closeAllConnections?.().catch(() => {});
    wc.stop?.();
    void wc.debugger.sendCommand("Emulation.setScriptExecutionDisabled", { value: true }).catch(() => {});
    onFailure("Защита страницы недоступна, профиль остановлен");
  };
  const send = async (method, params, id) => {
    let timer;
    try {
      return await Promise.race([wc.debugger.sendCommand(method, params, id), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Privacy setup timeout: " + method)), 4000); timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  };
  // Shared/service workers belong to a Session, not a tab. The browser-target
  // controller handles them; attaching here as well causes startup deadlocks.
  const autoAttach = (id) => send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: "worker" }, { type: "iframe" }, { type: "page" }, { exclude: true }],
  }, id);
  async function configureChild(id, type) {
    const page = type === "iframe" || type === "page";
    await send("Runtime.enable", {}, id);
    await send("Network.setUserAgentOverride", userAgentOverride(fp), id);
    if (page) {
      await send("Page.enable", {}, id);
      await send("Emulation.setTimezoneOverride", { timezoneId: fp.timezone }, id);
      await applyLocale(send, fp.languages[0], id);
      if (!fp.nativeHardwareMetrics) await send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: fp.hardwareConcurrency }, id);
      // CDP rejects metrics on iframe targets. The native session policy covers
      // their CSS; stock Electron's JS fallback cannot cover OOPIF CSS.
      if (type === "page" && !fp.nativeScreenMetrics) await send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: fp.os === "macos" ? 2 : 1, mobile: false, screenWidth: fp.screen.width, screenHeight: fp.screen.height }, id);
      await send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true }, id);
    } else {
      const evaluated = await send("Runtime.evaluate", { expression: source, returnByValue: true }, id);
      if (evaluated.exceptionDetails) throw new Error("Worker privacy setup failed");
    }
    await autoAttach(id);
    await send("Runtime.runIfWaitingForDebugger", {}, id);
  }
  wc.debugger.on?.("message", (_event, method, params) => {
    if (method === "Target.detachedFromTarget") { children.delete(params.sessionId); return; }
    if (method !== "Target.attachedToTarget") return;
    children.add(params.sessionId);
    void configureChild(params.sessionId, params.targetInfo.type).catch(() => {
      if (children.has(params.sessionId)) fail();
    });
  });
  wc.debugger.on?.("detach", (_event, reason) => { if (reason !== "target closed") fail(); });
  try {
    await autoAttach();
    await send("Page.enable");
    await Promise.all([
      send("Emulation.setUserAgentOverride", userAgentOverride(fp)),
      applyLocale(send, fp.languages[0]),
      send("Emulation.setTimezoneOverride", { timezoneId: fp.timezone }),
      ...(fp.nativeHardwareMetrics ? [] : [send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: fp.hardwareConcurrency })]),
      // Stock Electron fallback preserves viewport size but only covers the
      // top-level target. Native sessions must not receive a second override.
      ...(fp.nativeScreenMetrics ? [] : [send("Emulation.setDeviceMetricsOverride", {
        width: 0, height: 0, deviceScaleFactor: fp.os === "macos" ? 2 : 1, mobile: false,
        screenWidth: fp.screen.width, screenHeight: fp.screen.height,
      })]),
      send("Page.addScriptToEvaluateOnNewDocument", { source }),
    ]);
  } catch {
    stopped = true;
    if (wc.debugger.isAttached()) wc.debugger.detach();
    throw new Error("Unable to apply fingerprint before navigation");
  }
  const backgroundProtected = require("./background-workers.cjs").backgroundWorkersProtected(wc.session);
  return {
    engine: fp.nativeScreenMetrics ? "umbra-screen-electron" : "stock-electron", chromiumVersion: process.versions.chrome || null,
    backgroundWorkers: backgroundProtected ? "browser-target-before-execution" : "unprotected",
    uaLocaleTimezone: "cdp", documentOverrides: "main-world-javascript",
    screenMetrics: fp.nativeScreenMetrics ? "native-session-css-and-javascript" : "cdp-top-level-and-js-only-oopif",
    hardwareConcurrency: fp.nativeHardwareMetrics ? "native-session-renderer" : "cdp-and-prototype",
    deviceMemory: fp.nativeHardwareMetrics ? "native-session-renderer-and-request-headers" : "prototype-and-request-headers",
    webRTCPolicy: wc.getWebRTCIPHandlingPolicy(),
    canvasNoise: fp.aggressivePrivacyMode === false ? "disabled-in-normal-mode" : fp.canvasNoise ? "document-2d-readback-and-html-canvas-serialization-only" : "disabled",
    audioNoise: fp.aggressivePrivacyMode === false ? "disabled-in-normal-mode" : fp.audioNoise ? "document-analyser-and-copyFromChannel-only" : "disabled",
    unsupportedControls: ["fontsPreset", "webglNoise"],
    hardwarePolicy: fp.aggressivePrivacyMode === false ? "normal-native-hardware-apis" : "blocked-by-default-with-explicit-local-origin-exceptions",
    limitations: [fp.nativeScreenMetrics ? "Native screen isolation does not protect every hardware API or guarantee undetectability" : "No custom browser kernel or undetectability guarantee", backgroundProtected ? "Unexpected service-worker process loss stops the profile; reopen it to restore protection" : "Shared/service workers are not protected by the page debugger alone", "Normal mode and compatibility exceptions expose native GPU, audio, canvas and font characteristics", "Installed fonts can still affect CSS layout", "JavaScript privacy restrictions are observable", "Native WebRTC policy restricts non-proxied UDP", "Popup opener and form POST are unsupported", "Navigation history is not restored after restart"],
  };
}

async function applyLocale(send, locale, id) {
  try { await send("Emulation.setLocaleOverride", { locale }, id); }
  catch (error) {
    // Chromium's locale controller is renderer-wide and rejects a second
    // owner, even when a worker/page in this profile already set that locale.
    // Accept only an observed match, never an unchecked protocol failure.
    const result = await send("Runtime.evaluate", {
      expression: `Intl.DateTimeFormat().resolvedOptions().locale === Intl.DateTimeFormat(${JSON.stringify(locale)}).resolvedOptions().locale`,
      returnByValue: true,
    }, id);
    if (result.exceptionDetails || result.result?.value !== true) throw error;
  }
}

module.exports = { normalizeFingerprint, applyNativeScreenMetrics, applyNativeHardwareMetrics, applyFingerprint, userAgentOverride, installSessionPrivacy, hasCapability, applyLocale };
