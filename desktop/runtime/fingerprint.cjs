const fs = require("node:fs");
const path = require("node:path");
const DOCUMENT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "fingerprint-preload.cjs"), "utf8");

function normalizeFingerprint(raw = {}, defaultUA, runtimeChrome = process.versions.chrome) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid fingerprint");
  const integer = (value, fallback, min, max) => {
    if (value == null) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid fingerprint dimensions");
    return value;
  };
  let userAgent = raw.userAgent ?? raw.user_agent ?? defaultUA;
  if (typeof userAgent !== "string" || !userAgent || userAgent.length > 1024 || /[\r\n\0]/.test(userAgent)) throw new Error("Invalid user agent");
  const windows11 = raw.osVersion === "11.0" || /Windows NT 11/.test(userAgent);
  userAgent = userAgent.replace(/Windows NT 11\.0/g, "Windows NT 10.0");
  if (runtimeChrome) userAgent = userAgent.replace(/Chrome\/[\d.]+/g, `Chrome/${runtimeChrome}`);
  let languages;
  try { languages = Intl.getCanonicalLocales(raw.languages ?? [raw.language ?? "en-US", "en"]); }
  catch { throw new Error("Invalid fingerprint languages"); }
  if (!languages.length || languages.length > 10) throw new Error("Invalid fingerprint languages");
  const timezone = raw.timezone ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new Error("Invalid fingerprint timezone"); }
  const platform = raw.platform ?? "Win32";
  if (typeof platform !== "string" || platform.length > 64) throw new Error("Invalid fingerprint platform");
  const vendor = raw.gpu?.vendor ?? raw.webgl_vendor;
  const renderer = raw.gpu?.renderer ?? raw.webgl_renderer;
  if ([vendor, renderer].some((value) => value != null && (typeof value !== "string" || value.length > 1024))) throw new Error("Invalid fingerprint GPU");
  return {
    userAgent, platform, languages, timezone,
    screen: {
      width: integer(raw.screen?.width ?? raw.screen_width, 1280, 320, 16384),
      height: integer(raw.screen?.height ?? raw.screen_height, 800, 200, 16384),
      colorDepth: integer(raw.screen?.colorDepth ?? raw.color_depth, 24, 1, 64),
    },
    hardwareConcurrency: integer(raw.hardwareConcurrency ?? raw.hardware_concurrency, 8, 1, 256),
    deviceMemory: integer(raw.deviceMemory ?? raw.device_memory, 8, 1, 256),
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
  if (match && fp.platform === "Win32") {
    const major = match[1];
    const full = typeof fp.chromeVersion === "string" && new RegExp(`^${major}\\.\\d+\\.\\d+\\.\\d+$`).test(fp.chromeVersion) ? fp.chromeVersion : `${major}.${match[2]}`;
    result.userAgentMetadata = {
      brands: [{ brand: "Chromium", version: major }, { brand: "Google Chrome", version: major }, { brand: "Not_A Brand", version: "99" }],
      fullVersionList: [{ brand: "Chromium", version: full }, { brand: "Google Chrome", version: full }, { brand: "Not_A Brand", version: "99.0.0.0" }],
      fullVersion: full, platform: "Windows", platformVersion: fp.windows11 ? "13.0.0" : "10.0.0",
      architecture: "x86", bitness: "64", model: "", mobile: false, wow64: false,
    };
  }
  return result;
}

async function applyFingerprint(wc, fp) {
  wc.setUserAgent(fp.userAgent);
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  wc.debugger.attach("1.3");
  try {
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("Emulation.setUserAgentOverride", userAgentOverride(fp));
    await wc.debugger.sendCommand("Emulation.setLocaleOverride", { locale: fp.languages[0] });
    await wc.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: fp.timezone });
    await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(${DOCUMENT_SOURCE})(${JSON.stringify(fp)});` });
  } catch {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    throw new Error("Unable to apply fingerprint before navigation");
  }
  return {
    engine: "stock-electron", chromiumVersion: process.versions.chrome || null,
    uaLocaleTimezone: "cdp", documentOverrides: "main-world-javascript",
    webRTCPolicy: wc.getWebRTCIPHandlingPolicy(),
    canvasNoise: fp.canvasNoise ? "document-2d-readback-and-html-canvas-serialization-only" : "disabled",
    audioNoise: fp.audioNoise ? "document-analyser-and-copyFromChannel-only" : "disabled",
    unsupportedControls: ["fontsPreset", "webglNoise"],
    limitations: ["No custom browser kernel or undetectability guarantee", "Workers, service workers and out-of-process frames are not configured by this runtime", "Canvas overrides do not cover OffscreenCanvas, worker canvases or WebGL readPixels; subregion reads need not match serialization", "AudioBuffer.getChannelData retains native writable-buffer behavior", "Screen and GPU values are document JavaScript overrides, not native device emulation", "WebRTC disabling is document-only; native policy restricts non-proxied UDP", "Popup opener and form POST are unsupported", "Tabs and navigation history are not restored after restart"],
  };
}

module.exports = { normalizeFingerprint, applyFingerprint, userAgentOverride };
