// Подмена отпечатка внутри окна профиля. Базовый уровень: экран, ядра, память,
// языки, часовой пояс, WebGL-строки и шум Canvas/Audio.
const arg = process.argv.find((a) => a.startsWith("--umbra-fingerprint="));
let fp = {};
try {
  if (arg) fp = JSON.parse(decodeURIComponent(arg.split("=").slice(1).join("=")));
} catch {
  fp = {};
}

function define(obj, key, value) {
  try {
    Object.defineProperty(obj, key, { get: () => value, configurable: true });
  } catch {
    /* ignore */
  }
}

if (fp.hardware_concurrency) define(navigator, "hardwareConcurrency", fp.hardware_concurrency);
if (fp.device_memory) define(navigator, "deviceMemory", fp.device_memory);
if (fp.languages) {
  define(navigator, "languages", Object.freeze([...fp.languages]));
  define(navigator, "language", fp.languages[0]);
}
if (fp.platform) define(navigator, "platform", fp.platform);
if (fp.screen_width) {
  define(screen, "width", fp.screen_width);
  define(screen, "availWidth", fp.screen_width);
}
if (fp.screen_height) {
  define(screen, "height", fp.screen_height);
  define(screen, "availHeight", fp.screen_height - 40);
}
if (fp.color_depth) define(screen, "colorDepth", fp.color_depth);

if (fp.timezone) {
  const OriginalDTF = Intl.DateTimeFormat;
  const patched = function (locale, options) {
    return new OriginalDTF(locale || (fp.languages && fp.languages[0]), {
      ...options,
      timeZone: (options && options.timeZone) || fp.timezone,
    });
  };
  patched.supportedLocalesOf = OriginalDTF.supportedLocalesOf;
  Intl.DateTimeFormat = patched;
}

if (fp.webgl_vendor || fp.webgl_renderer) {
  const patch = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return fp.webgl_vendor || orig.call(this, p);
      if (p === 37446) return fp.webgl_renderer || orig.call(this, p);
      return orig.call(this, p);
    };
  };
  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
}

if (fp.canvas_noise) {
  const seed = Number(fp.canvas_noise) || 1;
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try {
      const ctx = this.getContext("2d");
      if (ctx && this.width && this.height) {
        const img = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < img.data.length; i += 997) {
          img.data[i] = (img.data[i] + (seed % 3)) % 256;
        }
        ctx.putImageData(img, 0, 0);
      }
    } catch {
      /* ignore */
    }
    return origToDataURL.apply(this, args);
  };
}
