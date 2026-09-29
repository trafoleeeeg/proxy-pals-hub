// Local synthetic test only. No real profiles, external network or preloads.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { applyFontIsolation } = require('../runtime/font-isolation.cjs');
assert.ok(process.env.UMBRA_FONT_TEST_DIR && process.env.UMBRA_FONT_BUNDLE_DIR);
app.setPath('userData', process.env.UMBRA_FONT_TEST_DIR);
app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
// Untrusted process flags must not opt other sessions into isolation.
app.commandLine.appendSwitch('umbra-isolate-fonts');
const windows = [];
let server, port;
const restrict = ses => {
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url);
    done({ cancel: !['about:', 'data:', 'blob:'].includes(url.protocol) &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === String(port)) });
  });
};
app.on('session-created', restrict);
const finish = code => {
  for (const w of windows) if (!w.isDestroyed()) w.destroy();
  server?.close(); app.exit(code);
};
setTimeout(() => { console.error('UMBRA_FONTS_FAILED: timeout'); finish(1); }, 110000).unref();

async function probe() {
  const fontSet = typeof document === 'object' ? document.fonts : self.fonts;
  const local = async name => {
    try { await new FontFace('LocalProbe', `local("${name}")`).load(); return true; }
    catch { return false; }
  };
  // local() matches full/PostScript face names, not CSS family names. These
  // names are read from the pinned TTF name tables (IDs 4 and 6).
  const bundled = await Promise.all(['Arimo-Regular', 'Tinos-Regular', 'Cousine-Regular', 'Arimo-Bold', 'Arimo Regular', 'Tinos Regular', 'Cousine Regular'].map(local));
  const host = await Promise.all(['Arial', 'Segoe UI', 'Courier New'].map(local));
  const downloadable = await new FontFace('WebFontProbe', 'url(/webfont.ttf)').load();
  fontSet.add(downloadable);
  const c = new OffscreenCanvas(800, 90), ctx = c.getContext('2d');
  const text = 'Hamburgefontsiv 0123456789 ЖшД';
  const widths = {};
  for (const family of ['Arimo', 'Tinos', 'Cousine', 'sans-serif', 'serif', 'monospace', 'system-ui', 'WebFontProbe']) {
    ctx.font = `32px ${family}`;
    widths[family] = ctx.measureText(text).width;
  }
  let domMatches = true, systemFontsFixed = true;
  if (typeof document === 'object') {
    for (const family of ['Arimo', 'Tinos', 'Cousine', 'sans-serif', 'serif', 'monospace', 'system-ui', 'WebFontProbe']) {
      const span = document.createElement('span'); span.textContent = text;
      span.style.cssText = `font:32px ${family};white-space:pre;display:inline-block`;
      document.body.append(span);
      domMatches &&= Math.abs(span.getBoundingClientRect().width - widths[family]) < 0.05;
      span.remove();
    }
    for (const kind of ['menu', 'small-caption', 'status-bar']) {
      const span = document.createElement('span'); span.style.font = kind;
      document.body.append(span); const style = getComputedStyle(span);
      systemFontsFixed &&= style.fontFamily === 'Arimo' && style.fontSize === '13px';
      span.remove();
    }
  }
  // Include fallback glyphs and all style selections in cross-context checks.
  for (const style of ['normal', 'bold', 'italic', 'bold italic']) {
    for (const family of ['Arimo', 'Tinos', 'Cousine']) {
      ctx.font = `${style} 32px ${family}`;
      widths[style + '/' + family] = ctx.measureText(text + ' 中文 😀').width;
    }
  }
  return { bundled, host, widths, domMatches, systemFontsFixed };
}

async function open(ses, url) {
  const win = new BrowserWindow({ show: false, webPreferences: {
    session: ses, sandbox: true, nodeIntegration: false, contextIsolation: true,
    additionalArguments: ['--umbra-isolate-fonts', '--UMBRA-ISOLATE-FONTS'] } });
  windows.push(win); await win.loadURL(url); return win;
}
function verify(r, name) {
  assert.ok(r.bundled.every(Boolean), `${name}: bundle local() lookup failed`);
  assert.ok(r.host.every(value => !value), `${name}: host local() font leaked`);
  assert.ok(r.domMatches, `${name}: DOM and Canvas metrics disagree`);
  assert.ok(r.systemFontsFixed, `${name}: system CSS font metrics leaked`);
  for (const [generic, fixed] of [['sans-serif', 'Arimo'], ['serif', 'Tinos'], ['monospace', 'Cousine'], ['system-ui', 'Arimo']])
    assert.ok(Math.abs(r.widths[generic] - r.widths[fixed]) < 0.001, `${name}: ${generic} fallback is not fixed`);
}
app.whenReady().then(async () => {
  restrict(session.defaultSession);
  assert.equal(typeof session.defaultSession.setUmbraFontIsolation, 'function', 'Native font API required');
  const names = ['Arimo', 'Tinos', 'Cousine'].flatMap(family => ['Regular', 'Bold', 'Italic', 'BoldItalic'].map(style => `${family}-${style}.ttf`));
  const files = names.map(name => path.join(process.env.UMBRA_FONT_BUNDLE_DIR, name));
  const bad = session.fromPartition('invalid-font-bundle');
  await assert.rejects(bad.setUmbraFontIsolation([]), /Invalid/);
  await assert.rejects(bad.setUmbraFontIsolation([files[0]]), /Invalid/);
  await assert.rejects(bad.setUmbraFontIsolation(['relative.ttf']), /Invalid/);
  const invalidFile = path.join(process.env.UMBRA_FONT_TEST_DIR, 'invalid-font.ttf');
  fs.writeFileSync(invalidFile, 'not a font');
  await assert.rejects(bad.setUmbraFontIsolation([invalidFile, ...files]), /Invalid/);
  await assert.rejects(bad.setUmbraFontIsolation(Array(33).fill(files[0])), /Invalid/);
  server = http.createServer((req, res) => {
    if (req.url === '/webfont.ttf') { res.setHeader('Content-Type', 'font/ttf'); return res.end(fs.readFileSync(files[2])); }
    if (req.url.endsWith('.js')) {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      const code = `const probe=${probe.toString()};`;
      if (req.url === '/worker.js') return res.end(code + 'probe().then(postMessage).catch(()=>postMessage({error:true}));');
      if (req.url === '/shared.js') return res.end(code + 'onconnect=e=>probe().then(r=>e.ports[0].postMessage(r));');
      return res.end(code + "oninstall=()=>self.skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>e.waitUntil(probe().then(r=>e.ports[0].postMessage(r))); ");
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><body>${req.url === '/root' ? `<iframe src="http://localhost:${port}/child"></iframe>` : ''}<script>globalThis.firstFonts=(${probe.toString()})();</script></body>`);
  });
  const portFile = path.join(process.env.UMBRA_FONT_TEST_DIR, 'port.json');
  const requestedPort = fs.existsSync(portFile) ? JSON.parse(fs.readFileSync(portFile, 'utf8')) : 0;
  assert.ok(Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort < 65536);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); });
  port = server.address().port; fs.writeFileSync(portFile, JSON.stringify(port));
  const origin = `http://127.0.0.1:${port}`;
  const ordinary = session.fromPartition('fonts-control');
  const control = await open(ordinary, origin);
  const before = await control.webContents.executeJavaScript(`(${probe.toString()})()`);
  assert.ok(before.host[0], 'Control must see Arial, proving the host-font negative test is meaningful');
  await assert.rejects(ordinary.setUmbraFontIsolation(files), /before/);
  const profiles = [session.fromPartition('persist:fonts-a'), session.fromPartition('persist:fonts-b')];
  for (const [i, ses] of profiles.entries()) {
    const fp = { fontIsolation: true };
    await applyFontIsolation(ses, fp, { bundleDirectory: process.env.UMBRA_FONT_BUNDLE_DIR });
    assert.equal(fp.nativeFontIsolation, true);
    const win = await open(ses, origin + '/root');
    await ses.setUmbraFontIsolation(files); // Exact reapplication is idempotent.
    await assert.rejects(ses.setUmbraFontIsolation([...files].reverse()), /before/);
    const root = win.webContents.mainFrame, child = root.frames[0];
    assert.ok(child && root.processId !== child.processId, 'Real OOPIF required');
    for (const [label, frame] of [['main', root], ['oopif', child]]) {
      const report = await frame.executeJavaScript('firstFonts');
      verify(report, `${i}/${label}`);
      const workers = await frame.executeJavaScript(`Promise.all([
        new Promise((resolve,reject)=>{const w=new Worker('/worker.js');w.onmessage=e=>{w.terminate();resolve(e.data)};w.onerror=reject}),
        new Promise((resolve,reject)=>{const w=new SharedWorker('/shared.js');globalThis.keep=w;w.port.onmessage=e=>resolve(e.data);w.onerror=reject}),
        navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(r=>new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=e=>resolve(e.data);r.active.postMessage('test',[c.port2])}))])`);
      for (const [j, worker] of workers.entries()) {
        verify(worker, `${i}/${label}/worker-${j}`);
        const differences = Object.keys(report.widths).filter(key => worker.widths[key] !== report.widths[key]);
        assert.ok(!differences.length, `${i}/${label}/worker-${j}: font metrics differ: ${differences.map(key => key + ' delta=' + (worker.widths[key] - report.widths[key])).join(', ')}`);
      }
    }
  }
  const after = await control.webContents.executeJavaScript(`(${probe.toString()})()`);
  assert.ok(JSON.stringify(before) === JSON.stringify(after), 'Isolation contaminated an ordinary session');
  console.log('UMBRA_FONTS_OK: DOM, CSS local(), Canvas, OOPIF and workers; ordinary session unchanged');
  finish(0);
}).catch(error => { console.error('UMBRA_FONTS_FAILED:', error.message); finish(1); });
