const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compare, plan, issueFor, marker } = require('./engine-update-monitor.cjs');

const pkg = { devDependencies: { electron: '44.4.5' } };
const lock = { electron: { tag: 'v44.4.5' }, chromium: { tag: '152.0.7977.130' } };

test('stable engine versions compare numerically', () => {
  assert.equal(compare('44.10.0', '44.9.9'), 1);
  assert.equal(compare('152.0.7977.130', '152.0.7977.130'), 0);
  assert.throws(() => compare('45.0.0-beta.1', '44.4.5'));
});

test('new Electron or Chromium creates an actionable maintenance task', () => {
  const update = plan(pkg, lock, '44.5.1', '154.0.8100.0');
  assert.equal(update.electronBehind, true);
  assert.equal(update.chromeBehind, true);
  const issue = issueFor(update);
  assert(issue.body.includes(marker));
  assert.match(issue.body, /source-lock\.json/);
  assert.match(issue.body, /SHA-256/);
  const current = plan(pkg, lock, '44.4.5', '152.0.7977.130');
  assert.equal(current.electronBehind, false);
  assert.equal(current.chromeBehind, false);
});

test('a package-only Electron update cannot masquerade as a new native engine', () => {
  assert.throws(() => plan({ devDependencies: { electron: '44.5.1' } }, lock, '44.5.1', '154.0.8100.0'));
});
