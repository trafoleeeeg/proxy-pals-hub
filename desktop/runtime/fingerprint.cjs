const fs = require("node:fs");
const path = require("node:path");
const DOCUMENT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "fingerprint-preload.cjs"), "utf8");
const WEBRTC_POLICY = "disable_non_proxied_udp";

function normalizeFingerprint(raw = {}, defaultUA, runtimeChrome = process.versions.chrome) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid fingerprint");
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
    userAgent, platform, os, osVersion, architecture, languages, timezone,
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

async function applyFingerprint(wc, fp) {
  wc.setUserAgent(fp.userAgent);
  wc.setWebRTCIPHandlingPolicy(WEBRTC_POLICY);
  if (wc.getWebRTCIPHandlingPolicy() !== WEBRTC_POLICY) throw new Error("Unable to apply fingerprint WebRTC policy");
  wc.debugger.attach("1.3");
  try {
    await wc.debugger.sendCommand("Page.enable");
    await Promise.all([
      wc.debugger.sendCommand("Emulation.setUserAgentOverride", userAgentOverride(fp)),
      wc.debugger.sendCommand("Emulation.setLocaleOverride", { locale: fp.languages[0] }),
      wc.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: fp.timezone }),
      wc.debugger.sendCommand("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: fp.hardwareConcurrency }),
      // Match screen CSS queries to window.screen without forcing a viewport,
      // zoom or host DPI. Width/height/DPR zero preserve native window sizing.
      wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 0, height: 0, deviceScaleFactor: 0, mobile: false,
        screenWidth: fp.screen.width, screenHeight: fp.screen.height,
      }),
      wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(${DOCUMENT_SOURCE})(${JSON.stringify(fp)});` }),
    ]);
  } catch {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    throw new Error("Unable to apply fingerprint before navigation");
  }
  return {
    engine: "stock-electron", chromiumVersion: process.versions.chrome || null,
    uaLocaleTimezone: "cdp", documentOverrides: "main-world-javascript",
    screenMetrics: "cdp-screen-only", hardwareConcurrency: "cdp-and-document",
    webRTCPolicy: wc.getWebRTCIPHandlingPolicy(),
    canvasNoise: fp.canvasNoise ? "document-2d-readback-and-html-canvas-serialization-only" : "disabled",
    audioNoise: fp.audioNoise ? "document-analyser-and-copyFromChannel-only" : "disabled",
    unsupportedControls: ["fontsPreset", "webglNoise"],
    limitations: ["No custom browser kernel or undetectability guarantee", "Workers, service workers and out-of-process frames are not independently configured by this runtime", "Canvas overrides do not cover OffscreenCanvas, worker canvases or WebGL readPixels; subregion reads need not match serialization", "AudioBuffer.getChannelData retains native writable-buffer behavior", "GPU values are document WebGL overrides, not native GPU or WebGPU emulation; fonts and host DPI remain native", "WebRTC disabling is document-only; native policy restricts non-proxied UDP", "Popup opener and form POST are unsupported", "Navigation history is not restored after restart"],
  };
}

module.exports = { normalizeFingerprint, applyFingerprint, userAgentOverride };
