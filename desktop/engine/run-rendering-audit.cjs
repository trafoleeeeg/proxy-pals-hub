const { spawnBrowser } = require('../runtime/browser-pipe.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const executable = process.argv[2];
  assert.ok(executable && path.isAbsolute(executable), 'Pass the absolute path to the custom Electron executable');
  await fs.access(executable);
  assert.ok(process.argv.slice(3).every(arg => arg === '--software-research'), 'Unknown audit option');
  // The experimental backend is opt-in for local synthetic research only.
  for (const software of process.argv.includes('--software-research') ? ['0', '1'] : ['0']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-rendering-audit-'));
    try {
      const child = spawnBrowser(executable, [path.join(__dirname, 'audit-rendering.cjs')], { env: { ...process.env, UMBRA_RENDERING_AUDIT_DIR: directory, UMBRA_RENDERING_AUDIT_SOFTWARE: software } });
      let output = '';
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
      // Suppress host paths/device details emitted by Chromium itself.
      child.stderr.on('data', chunk => {
        output = (output + String(chunk).split(/\r?\n/).filter(line => line.startsWith('UMBRA_RENDERING_AUDIT_FAILED:')).join('\n')).slice(-65536);
      });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Rendering audit timed out')); }, 100000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, output || 'Rendering audit failed');
      const result = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
      console.log(JSON.stringify(result, null, 2));
      for (const [mode, frames] of Object.entries(result.profiles)) {
        for (const [frame, report] of Object.entries(frames)) {
          for (const [key, passed] of Object.entries(report.canvas)) assert.equal(passed, true, `${mode}/${frame}/canvas/${key}`);
          for (const key of ['copyMatches', 'offsetMatches', 'untouchedTail']) assert.equal(report.audio[key], true, `${mode}/${frame}/audio/${key}`);
          for (const [key, passed] of Object.entries(report.worker)) assert.equal(passed, true, `${mode}/${frame}/worker/${key}`);
          assert.equal(report.fonts.localEnumerationEmptyOrDenied, true, `${mode}/${frame}/font enumeration must not return host fonts`);
          if (mode === 'font-isolated') assert.equal(report.fonts.localFontAvailable, false, `${mode}/${frame}/CSS local(Arial) must not access the host font`);
          if (report.webgl) {
            assert.equal(report.webgl.syntheticLabel, false, 'Do not report a GPU that the renderer does not emulate');
            assert.equal(report.webgl.nativeGetter, true, 'Allowed WebGL parameters must stay native');
          }
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  console.log('UMBRA_RENDERING_CONSISTENCY_OK: native readbacks agree; hardware anonymity NOT asserted');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
