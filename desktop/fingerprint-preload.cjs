// Installed before website code in documents and attached worker targets.
// Privacy controls are intentionally observable; they do not emulate hardware.
function applyDocumentFingerprint(fp) {
  const define = (object, key, value) => {
    Object.defineProperty(object, key, { get: () => value, configurable: true });
  };
  const nav = globalThis.Navigator?.prototype || globalThis.WorkerNavigator?.prototype || navigator;
  if (!fp.nativeHardwareMetrics) {
    define(nav, "hardwareConcurrency", fp.hardwareConcurrency);
    define(nav, "deviceMemory", fp.deviceMemory);
  }
  define(nav, "doNotTrack", fp.doNotTrack ? "1" : null);
  define(nav, "languages", Object.freeze([...fp.languages]));
  define(nav, "language", fp.languages[0]);
  define(nav, "platform", fp.platform);
  define(nav, "userAgent", fp.userAgent);
  define(nav, "appVersion", fp.userAgent.replace(/^Mozilla\//, ""));
  // Never inherit an exception from the top frame or a wildcard. Opaque
  // documents (data:, sandboxed frames) stay restricted.
  const origin = globalThis.origin || globalThis.location?.origin;
  const strict = fp.aggressivePrivacyMode !== false;
  const legacyAllowed = origin && origin !== "null" && !fp.hardwarePermissions && fp.hardwareOrigins?.includes(origin) === true;
  const grants = origin && origin !== "null" ? fp.hardwarePermissions?.[origin] : null;
  const allowed = (capability) => !strict || legacyAllowed || (Array.isArray(grants) && grants.includes(capability));
  if (!allowed("gpu")) {
    define(nav, "gpu", undefined);
    for (const ctor of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
      if (!ctor) continue;
      const original = ctor.prototype.getContext;
      ctor.prototype.getContext = function (type, ...args) {
        if (["webgl", "experimental-webgl", "webgl2", "webgpu"].includes(String(type).toLowerCase())) return null;
        return original.call(this, type, ...args);
      };
    }
  }
  if (!allowed("workers")) {
    define(nav, "serviceWorker", undefined);
    define(globalThis, "SharedWorker", undefined);
  }
  if (!allowed("audio")) for (const name of ["AudioContext", "webkitAudioContext", "OfflineAudioContext", "webkitOfflineAudioContext"]) define(globalThis, name, undefined);
  if (!allowed("fonts")) define(globalThis, "queryLocalFonts", undefined);
  if (!allowed("canvas")) {
    const denied = () => { throw new DOMException("Hardware readback blocked by profile privacy settings", "SecurityError"); };
    for (const ctor of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
      if (!ctor) continue;
      for (const method of ["toDataURL", "toBlob", "convertToBlob"]) if (typeof ctor.prototype[method] === "function") ctor.prototype[method] = denied;
    }
    for (const ctor of [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]) {
      if (ctor) ctor.prototype.getImageData = denied;
    }
  }
  // Native Screen and DPR getters also drive CSS in cross-origin frames. A
  // JavaScript accessor here would hide the zoom-aware native value.
  if (globalThis.screen && !fp.nativeScreenMetrics) {
    define(globalThis, "devicePixelRatio", fp.os === "macos" ? 2 : 1);
    const screenProto = globalThis.Screen?.prototype || screen;
    define(screenProto, "width", fp.screen.width);
    define(screenProto, "height", fp.screen.height);
    define(screenProto, "availWidth", fp.screen.width);
    define(screenProto, "availHeight", Math.max(1, fp.screen.height - (fp.os === "macos" ? 25 : 40)));
    define(screenProto, "colorDepth", fp.screen.colorDepth);
    define(screenProto, "pixelDepth", fp.screen.colorDepth);
  }
  // Allowed APIs stay native. The former partial Canvas/Audio noise disagreed
  // with OffscreenCanvas, cropped readbacks and AudioBuffer.getChannelData;
  // copyFromChannel even modified destination samples outside its copy range.
  // Changing two WebGL labels did not change WebGPU, limits or rendered pixels.
  // Compatibility consent permits native hardware exposure, not emulation.
  // Windows passkey prompts open a native dialog over the page and expose the
  // real device, so the profile reports no authenticator at all.
  define(globalThis, "PublicKeyCredential", undefined);
  if (navigator.credentials) {
    for (const method of ["get", "create"]) {
      const credentials = globalThis.CredentialsContainer?.prototype || navigator.credentials;
      const original = credentials[method];
      if (typeof original !== "function") continue;
      credentials[method] = function (options) {
        if (options && options.publicKey) {
          return Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
        }
        return original.call(this, options);
      };
    }
  }
  // Profile sessions deny microphone/camera access. Do not still expose the
  // number and stable identifiers of attached devices through enumeration.
  if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === "function") {
    const media = globalThis.MediaDevices?.prototype || navigator.mediaDevices;
    media.enumerateDevices = function () { return Promise.resolve([]); };
  }
  // This document-level switch supplements the native non-proxied UDP policy.
  if (fp.webrtc === "disabled") {
    define(globalThis, "RTCPeerConnection", undefined);
    define(globalThis, "webkitRTCPeerConnection", undefined);
  }
}
