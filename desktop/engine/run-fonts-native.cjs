const { spawnBrowser } = require('../runtime/browser-pipe.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { verifyFontBundle } = require('../runtime/font-isolation.cjs');
(async () => {
  const [executable, bundle] = process.argv.slice(2);
  assert.ok(executable && bundle && path.isAbsolute(executable) && path.isAbsolute(bundle), 'Pass absolute engine and font-bundle paths');
  await verifyFontBundle(bundle);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-fonts-native-'));
  try {
    for (let launch = 0; launch < 2; launch++) {
      const child = spawnBrowser(executable, [path.join(__dirname, 'test-fonts-native.cjs')], {
        env: { ...process.env, UMBRA_FONT_TEST_DIR: directory, UMBRA_FONT_BUNDLE_DIR: bundle } });
      const logs = { stdout: '', stderr: '' };
      for (const channel of ['stdout', 'stderr'])
        child[channel].on('data', chunk => { logs[channel] = (logs[channel] + chunk).slice(-32768); });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Font test timed out')); }, 125000);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('close', c => { clearTimeout(timer); resolve(c); });
      });
      // Filter complete lines, not chunks; never emit host device/path logs.
      const output = Object.values(logs).join('\n').split(/\r?\n/)
        .filter(line => line.startsWith('UMBRA_FONTS_')).join('\n');
      assert.equal(code, 0, output || 'Font test failed');
      assert.ok(output.includes('UMBRA_FONTS_OK:'), 'Missing font test result');
      console.log(output);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
