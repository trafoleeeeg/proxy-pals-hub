// Research only: synthetic loopback origins, disposable sessions, no uploads.
// No real GPU names, font inventories, audio data or hashes leave the renderer.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { normalizeFingerprint, applyFingerprint, applyNativeScreenMetrics, applyNativeHardwareMetrics } = require('../runtime/fingerprint.cjs');
const { initializeBackgroundWorkers, protectBackgroundWorkers } = require('../runtime/background-workers.cjs');

assert.ok(process.env.UMBRA_RENDERING_AUDIT_DIR);
app.setPath('userData', process.env.UMBRA_RENDERING_AUDIT_DIR);
app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const denyExternalRequests = ses => ses.webRequest.onBeforeRequest((details, done) => {
  done({ cancel: !['about:', 'data:', 'blob:'].includes(new URL(details.url).protocol) });
});
// Cover default/background sessions as well. Fixture sessions replace this
// with the exact loopback origin allowance before creating any documents.
app.on('session-created', denyExternalRequests);
const software = process.env.UMBRA_RENDERING_AUDIT_SOFTWARE === '1';
if (software) {
  // Explicit test driver, not the unsafe automatic WebGL fallback. Never use
  // --no-sandbox, --enable-unsafe-swiftshader or --enable-unsafe-webgpu here.
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}
const windows = [];
let server;
function finish(code) {
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  server?.close();
  app.exit(code);
}
setTimeout(() => finish(1), 90000).unref();

async function sampleWorker() {
  const c = new OffscreenCanvas(64, 32);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#748693'; ctx.fillRect(0, 0, 64, 32);
  const pixels = [...ctx.getImageData(0, 0, 64, 32).data];
  const gc = new OffscreenCanvas(64, 32);
  const gl = gc.getContext('webgl2') || gc.getContext('webgl');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  const adapter = await navigator.gpu?.requestAdapter();
  return { pixels, renderer, gpuAvailable: !!adapter };
}

async function sample() {
  const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 32;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const paint = c => { c.fillStyle = '#748693'; c.fillRect(0, 0, 64, 32); };
  paint(ctx);
  const pixels = ctx.getImageData(0, 0, 64, 32).data;
  const crop = ctx.getImageData(1, 0, 63, 32).data;
  const expectedCrop = [];
  for (let y = 0; y < 32; y++) expectedCrop.push(...pixels.slice((y * 64 + 1) * 4, (y + 1) * 64 * 4));
  const offscreen = new OffscreenCanvas(64, 32);
  const offctx = offscreen.getContext('2d', { willReadFrequently: true });
  paint(offctx);
  const image = new Image();
  image.src = canvas.toDataURL();
  await image.decode();
  // Compare a PNG decode via an OffscreenCanvas to avoid applying an HTML
  // readback wrapper twice to an already modified PNG.
  const pngOffscreen = new OffscreenCanvas(64, 32);
  const pngCtx = pngOffscreen.getContext('2d'); pngCtx.drawImage(image, 0, 0);
  const audio = new OfflineAudioContext(1, 512, 48000);
  const buffer = audio.createBuffer(1, 512, 48000);
  buffer.getChannelData(0).fill(0.125);
  const direct = [...buffer.getChannelData(0)];
  const copy = new Float32Array(512); buffer.copyFromChannel(copy, 0);
  const offset = new Float32Array(128); buffer.copyFromChannel(offset, 0, 97);
  const tail = new Float32Array(600); tail.fill(0.75); buffer.copyFromChannel(tail, 0);
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl2') || glCanvas.getContext('webgl');
  let renderer = '';
  let webgl = null;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    webgl = { available: true, software: /swiftshader|software|llvmpipe/i.test(renderer), syntheticLabel: renderer === 'Umbra synthetic audit GPU', nativeGetter: /\[native code\]/.test(Function.prototype.toString.call(gl.getParameter)) };
  }
  const adapter = await navigator.gpu?.requestAdapter();
  const info = adapter?.info;
  const webgpu = { available: !!adapter, fallback: !!info?.isFallbackAdapter, software: !!info && /swiftshader|software|llvmpipe/i.test([info.vendor, info.architecture, info.device, info.description].join(' ')) };
  const realtime = new AudioContext();
  const audioDefaults = { rateMatchesExplicitOffline: realtime.sampleRate === audio.sampleRate, nativeRateGetter: /\[native code\]/.test(Function.prototype.toString.call(Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'sampleRate').get)) };
  await realtime.close();
  const worker = await new Promise((resolve, reject) => {
    const w = new Worker('/render-worker.js');
    const timer = setTimeout(() => { w.terminate(); reject(new Error('Rendering worker timeout')); }, 10000);
    w.onmessage = e => { clearTimeout(timer); w.terminate(); resolve(e.data); };
    w.onerror = () => { clearTimeout(timer); w.terminate(); reject(new Error('Rendering worker failed')); };
  });
  let localFontAvailable = false;
  try { await new FontFace('UmbraLocalFontAudit', 'local("Arial")').load(); localFontAvailable = true; } catch { /* platform-dependent availability */ }
  let localEnumerationEmptyOrDenied = true;
  if (typeof queryLocalFonts === 'function') {
    // Chromium resolves [] (rather than rejecting) when permission is denied.
    try { localEnumerationEmptyOrDenied = (await queryLocalFonts()).length === 0; } catch { /* expected permission denial */ }
  }
  return {
    canvas: { cropMatches: same([...crop], expectedCrop), offscreenMatches: same([...pixels], [...offctx.getImageData(0, 0, 64, 32).data]), pngMatches: same([...pixels], [...pngCtx.getImageData(0, 0, 64, 32).data]), repeatedReadStable: same([...pixels], [...ctx.getImageData(0, 0, 64, 32).data]) },
    audio: { copyMatches: same(direct, [...copy]), offsetMatches: same(direct.slice(97, 225), [...offset]), untouchedTail: [...tail.slice(512)].every(v => v === 0.75), ...audioDefaults },
    webgl, webgpu,
    worker: { canvasMatches: same([...pixels], worker.pixels), webglRendererMatches: renderer === worker.renderer, webgpuAvailabilityMatches: !!adapter === worker.gpuAvailable },
    fonts: { localFontAvailable, fontSetAccessible: !!document.fonts, localEnumerationEmptyOrDenied },
  };
}

app.whenReady().then(async () => {
  denyExternalRequests(session.defaultSession);
  await initializeBackgroundWorkers();
  server = http.createServer((req, res) => {
    if (req.url === '/render-worker.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(`(${sampleWorker.toString()})().then(v => postMessage(v));`);
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Rendering audit</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const result = { driver: software ? 'software-research' : 'default', profiles: {} };
  for (const mode of ['normal', 'strict-exception']) {
    const fp = normalizeFingerprint({ os: 'windows', userAgent: 'Mozilla/5.0 Chrome/152.0.0.0', aggressivePrivacyMode: mode !== 'normal', canvasNoise: 17491, audioNoise: 27491, gpu: { vendor: 'Umbra synthetic audit vendor', renderer: 'Umbra synthetic audit GPU' } });
    fp.hardwarePermissions = { [origin]: ['gpu', 'canvas', 'audio', 'fonts', 'workers'], [`http://localhost:${port}`]: ['gpu', 'canvas', 'audio', 'fonts', 'workers'] };
    const ses = session.fromPartition('rendering-audit-' + randomUUID());
    ses.webRequest.onBeforeRequest((d, done) => {
      const u = new URL(d.url);
      done({ cancel: !['about:', 'blob:'].includes(u.protocol) && !(u.protocol === 'http:' && u.port === String(port) && ['localhost', '127.0.0.1'].includes(u.hostname)) });
    });
    ses.setPermissionRequestHandler((_wc, _p, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    applyNativeScreenMetrics(ses, fp, { required: true });
    applyNativeHardwareMetrics(ses, fp, { required: true });
    await protectBackgroundWorkers(ses, fp, { onFailure: () => finish(1) });
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.push(win);
    await win.loadURL('about:blank');
    await applyFingerprint(win.webContents, fp, { onFailure: () => finish(1) });
    await win.loadURL(origin);
    const main = await win.webContents.executeJavaScript(`(${sample.toString()})()`);
    await win.webContents.executeJavaScript(`new Promise(resolve => { const f = document.createElement('iframe'); f.onload = resolve; f.src = 'http://localhost:${port}'; document.body.appendChild(f); })`);
    const frame = win.webContents.mainFrame.frames[0];
    assert.notEqual(frame.processId, win.webContents.mainFrame.processId, 'must audit a real OOPIF');
    result.profiles[mode] = { main, oopif: await frame.executeJavaScript(`(${sample.toString()})()`) };
  }
  fs.writeFileSync(path.join(process.env.UMBRA_RENDERING_AUDIT_DIR, 'report.json'), JSON.stringify(result, null, 2));
  console.log('UMBRA_RENDERING_AUDIT:' + JSON.stringify(result));
  finish(0);
}).catch(error => { console.error('UMBRA_RENDERING_AUDIT_FAILED:' + error.message); finish(1); });
