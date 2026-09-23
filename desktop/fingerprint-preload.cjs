// Installed before website code in documents and attached worker targets.
// Privacy controls are intentionally observable; they do not emulate hardware.
function applyDocumentFingerprint(fp) {
  const define = (object, key, value) => {
    Object.defineProperty(object, key, { get: () => value, configurable: true });
  };
  const nav = globalThis.Navigator?.prototype || globalThis.WorkerNavigator?.prototype || navigator;
  define(nav, "hardwareConcurrency", fp.hardwareConcurrency);
  define(nav, "deviceMemory", fp.deviceMemory);
  define(nav, "doNotTrack", fp.doNotTrack ? "1" : null);
  define(nav, "languages", Object.freeze([...fp.languages]));
  define(nav, "language", fp.languages[0]);
  define(nav, "platform", fp.platform);
  define(nav, "userAgent", fp.userAgent);
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
  if (globalThis.screen) {
    define(globalThis, "devicePixelRatio", fp.os === "macos" ? 2 : 1);
    const screenProto = globalThis.Screen?.prototype || screen;
    define(screenProto, "width", fp.screen.width);
    define(screenProto, "height", fp.screen.height);
    define(screenProto, "availWidth", fp.screen.width);
    define(screenProto, "availHeight", Math.max(1, fp.screen.height - (fp.os === "macos" ? 25 : 40)));
    define(screenProto, "colorDepth", fp.screen.colorDepth);
    define(screenProto, "pixelDepth", fp.screen.colorDepth);
  }
  for (const ctor of strict ? [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext] : []) {
    if (!ctor) continue;
    const original = ctor.prototype.getParameter;
    ctor.prototype.getParameter = function (parameter) {
      if (parameter === 37445 && fp.gpu.vendor) return fp.gpu.vendor;
      if (parameter === 37446 && fp.gpu.renderer) return fp.gpu.renderer;
      return original.call(this, parameter);
    };
  }
  const delta = (seed, index) => {
    let value = (seed ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
    return (value & 1) ? 1 : -1;
  };
  if (strict && allowed("canvas") && fp.canvasNoise && globalThis.CanvasRenderingContext2D) {
    const originalGet = CanvasRenderingContext2D.prototype.getImageData;
    const perturb = (data, width, height) => {
      // Fingerprint probes use small synthetic canvases. Never rewrite large
      // canvases used by sites for photos, previews, maps or their interface:
      // doing so creates visible stripes and can break image lazy-loading.
      if (!width || !height || width * height > 262144) return;
      for (let index = 0; index < data.length; index += 4093) {
        data[index] = Math.max(0, Math.min(255, data[index] + delta(fp.canvasNoise ^ width ^ height, index)));
      }
    };
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const result = originalGet.apply(this, args);
      perturb(result.data, result.width, result.height);
      return result;
    };
    const copy = (canvas) => {
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 262144) return canvas;
      const cloned = document.createElement("canvas");
      cloned.width = canvas.width; cloned.height = canvas.height;
      if (canvas.width && canvas.height) {
        const context = cloned.getContext("2d");
        context.drawImage(canvas, 0, 0);
        const pixels = originalGet.call(context, 0, 0, canvas.width, canvas.height);
        perturb(pixels.data, pixels.width, pixels.height);
        context.putImageData(pixels, 0, 0);
      }
      return cloned;
    };
    for (const method of ["toDataURL", "toBlob"]) {
      const original = HTMLCanvasElement.prototype[method];
      HTMLCanvasElement.prototype[method] = function (...args) { return original.apply(copy(this), args); };
    }
  }
  if (strict && allowed("audio") && fp.audioNoise) {
    const perturb = (data) => {
      for (let index = 0; index < data.length; index += 97) if (Number.isFinite(data[index])) data[index] += delta(fp.audioNoise, index) * 1e-7;
    };
    if (globalThis.AudioBuffer) {
      const original = AudioBuffer.prototype.copyFromChannel;
      AudioBuffer.prototype.copyFromChannel = function (destination, ...args) {
        const result = original.call(this, destination, ...args);
        perturb(destination);
        return result;
      };
    }
    if (globalThis.AnalyserNode) {
      for (const method of ["getFloatFrequencyData", "getFloatTimeDomainData"]) {
        const original = AnalyserNode.prototype[method];
        AnalyserNode.prototype[method] = function (destination) { const result = original.call(this, destination); perturb(destination); return result; };
      }
    }
  }
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
