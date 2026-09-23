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

function installSessionPrivacy(ses, fp) {
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
    const headers = { ...details.requestHeaders };
    const offeredHints = [];
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "service-worker") {
        let origin; try { origin = new URL(details.url).origin; } catch { /* deny below */ }
        if (!hasCapability(fp, origin, "workers")) { callback({ cancel: true }); return; }
      }
      if (lower.startsWith("sec-ch-ua")) { offeredHints.push(lower); delete headers[key]; }
      if (["user-agent", "accept-language"].includes(lower)) delete headers[key];
    }
    headers["User-Agent"] = fp.userAgent;
    headers["Accept-Language"] = fp.languages.map((language, i) => i ? `${language};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}` : language).join(",");
    for (const key of offeredHints) if (hints[key]) headers[key] = hints[key];
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
  const windows11 = os === "windows" && (/^(?:Windows\s+)?11(?:\.|$)/i.test(raw.osVersion || "") || /Windows NT 11/.test(userAgent));
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
  let languages;
  try { languages = Intl.getCanonicalLocales(raw.languages ?? [raw.language ?? "en-US", "en"]); }
  catch { throw new Error("Invalid fingerprint languages"); }
  if (!languages.length || languages.length > 10) throw new Error("Invalid fingerprint languages");
  const timezone = raw.timezone ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new Error("Invalid fingerprint timezone"); }
  const platform = os === "macos" ? "MacIntel" : "Win32";
  const vendor = raw.gpu?.vendor ?? raw.webgl_vendor;
  const renderer = raw.gpu?.renderer ?? raw.webgl_renderer;
  if ([vendor, renderer].some((value) => value != null && (typeof value !== "string" || value.length > 1024))) throw new Error("Invalid fingerprint GPU");
  return {
    userAgent, platform, os, osVersion, architecture, languages, timezone, aggressivePrivacyMode,
    screen: {
      width: integer(raw.screen?.width ?? raw.screen_width, 1280, 320, 16384),
      height: integer(raw.screen?.height ?? raw.screen_height, 800, 200, 16384),
      colorDepth: integer(raw.screen?.colorDepth ?? raw.color_depth, 24, 1, 64),
    },
    hardwareConcurrency: integer(raw.hardwareConcurrency ?? raw.hardware_concurrency, 8, 1, 256),
    // Chromium exposes coarse memory buckets with an 8 GiB upper bound.
    deviceMemory: Math.min(8, 2 ** Math.floor(Math.log2(integer(raw.deviceMemory ?? raw.device_memory, 8, 1, 256)))),
    gpu: { vendor, renderer }, doNotTrack: !!(raw.doNotTrack ?? raw.do_not_track),
    webrtc: raw.webrtc === "disabled" ? "disabled" : "proxy",
    chromeVersion: runtimeChrome || raw.chromeVersion || raw.chrome_version,
    windows11,
    canvasNoise: integer(raw.canvasNoise ?? raw.canvas_noise, 0, 0, 2147483647),
    audioNoise: integer(raw.audioNoise ?? raw.audio_noise, 0, 0, 2147483647),
  };
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
        timer = setTimeout(() => reject(new Error("Privacy setup timeout")), 4000); timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  };
  // Shared/service workers cannot be configured reliably before execution in
  // this Electron version. The strict document policy blocks their creation;
  // only explicit site exceptions can use their native implementation.
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
      await send("Emulation.setLocaleOverride", { locale: fp.languages[0] }, id);
      await send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: fp.hardwareConcurrency }, id);
      // OOPIFs inherit top-level device metrics. CDP rejects this method on
      // iframe targets; Screen prototypes cover their JavaScript accessors.
      if (type === "page") await send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: fp.os === "macos" ? 2 : 1, mobile: false, screenWidth: fp.screen.width, screenHeight: fp.screen.height }, id);
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
      send("Emulation.setLocaleOverride", { locale: fp.languages[0] }),
      send("Emulation.setTimezoneOverride", { timezoneId: fp.timezone }),
      send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: fp.hardwareConcurrency }),
      // Preserve viewport size, but do not expose the physical host's DPI.
      send("Emulation.setDeviceMetricsOverride", {
        width: 0, height: 0, deviceScaleFactor: fp.os === "macos" ? 2 : 1, mobile: false,
        screenWidth: fp.screen.width, screenHeight: fp.screen.height,
      }),
      send("Page.addScriptToEvaluateOnNewDocument", { source }),
    ]);
  } catch {
    stopped = true;
    if (wc.debugger.isAttached()) wc.debugger.detach();
    throw new Error("Unable to apply fingerprint before navigation");
  }
  return {
    engine: "stock-electron", chromiumVersion: process.versions.chrome || null,
    uaLocaleTimezone: "cdp", documentOverrides: "main-world-javascript",
    screenMetrics: "cdp-screen-and-dpr", hardwareConcurrency: "cdp-and-prototype",
    webRTCPolicy: wc.getWebRTCIPHandlingPolicy(),
    canvasNoise: fp.aggressivePrivacyMode === false ? "disabled-in-normal-mode" : fp.canvasNoise ? "document-2d-readback-and-html-canvas-serialization-only" : "disabled",
    audioNoise: fp.aggressivePrivacyMode === false ? "disabled-in-normal-mode" : fp.audioNoise ? "document-analyser-and-copyFromChannel-only" : "disabled",
    unsupportedControls: ["fontsPreset", "webglNoise"],
    hardwarePolicy: fp.aggressivePrivacyMode === false ? "normal-native-hardware-apis" : "blocked-by-default-with-explicit-local-origin-exceptions",
    limitations: ["No custom browser kernel or undetectability guarantee", fp.aggressivePrivacyMode === false ? "Normal mode exposes native GPU, canvas, audio, fonts and background workers; they can reveal host hardware and disagree with the declared fingerprint" : "Shared/service workers are blocked by default; site exceptions expose their native identity", "Compatibility exceptions expose native GPU, audio and canvas characteristics", "Installed fonts can still affect CSS layout", "JavaScript privacy restrictions are observable", "Native WebRTC policy restricts non-proxied UDP", "Popup opener and form POST are unsupported", "Navigation history is not restored after restart"],
  };
}

module.exports = { normalizeFingerprint, applyFingerprint, userAgentOverride, installSessionPrivacy, hasCapability };
