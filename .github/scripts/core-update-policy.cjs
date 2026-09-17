const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

function version(value) {
  assert.equal(typeof value, 'string');
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'Only stable versions are allowed');
  const parts = value.split('.').map(Number);
  assert(parts.every(Number.isSafeInteger), 'Invalid version');
  return parts;
}
function compare(a, b) {
  const left = version(a), right = version(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function nextPatch(value) {
  const parts = version(value); parts[2]++;
  return parts.join('.');
}
function dependencyPaths(lock) {
  const paths = new Set();
  function visit(key) {
    if (paths.has(key)) return;
    const entry = lock.packages[key];
    assert(entry, 'Missing Electron dependency: ' + key);
    paths.add(key);
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      let parent = key, found;
      while (parent) {
        const candidate = parent + '/node_modules/' + name;
        if (lock.packages[candidate]) { found = candidate; break; }
        const pos = parent.lastIndexOf('/node_modules/');
        parent = pos < 0 ? '' : parent.slice(0, pos);
      }
      found ||= 'node_modules/' + name;
      if (!lock.packages[found] && entry.optionalDependencies?.[name]) continue;
      visit(found);
    }
  }
  visit('node_modules/electron');
  return paths;
}
function validateUpdate(before, after, oldLock, newLock, engine) {
  assert(compare(engine, before.devDependencies.electron) > 0, 'Engine must advance');
  const expected = structuredClone(before);
  expected.version = nextPatch(before.version);
  expected.devDependencies.electron = engine;
  assert.deepEqual(after, expected, 'Only Electron and the application patch version may change');
  assert.equal(newLock.version, expected.version);
  assert.equal(newLock.packages[''].version, expected.version);
  assert.equal(newLock.packages[''].devDependencies.electron, engine);
  const root = structuredClone(oldLock.packages['']);
  root.version = expected.version; root.devDependencies.electron = engine;
  assert.deepEqual(newLock.packages[''], root, 'Unexpected root lockfile change');
  const oldMeta = { ...oldLock }, newMeta = { ...newLock };
  delete oldMeta.packages; delete newMeta.packages;
  oldMeta.version = expected.version;
  assert.deepEqual(newMeta, oldMeta, 'Unexpected lockfile metadata');
  const allowed = new Set([...dependencyPaths(oldLock), ...dependencyPaths(newLock)]);
  for (const key of new Set([...Object.keys(oldLock.packages), ...Object.keys(newLock.packages)])) {
    if (!key) continue;
    if (!allowed.has(key)) assert.deepEqual(newLock.packages[key], oldLock.packages[key], 'Unrelated dependency changed: ' + key);
    else if (newLock.packages[key] && !isDeepStrictEqual(newLock.packages[key], oldLock.packages[key])) {
      const item = newLock.packages[key];
      assert(/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity || ''), 'Missing dependency integrity');
      const url = new URL(item.resolved);
      assert.equal(url.origin, 'https://registry.npmjs.org', 'Unexpected dependency registry');
    }
  }
  assert.equal(newLock.packages['node_modules/electron'].version, engine);
  return expected.version;
}
function workflowSucceeded(runs, sha, since) {
  const run = runs.find((item) => item.event === 'workflow_dispatch' && item.head_sha === sha && Date.parse(item.created_at) >= since);
  if (!run || run.status !== 'completed') return false;
  assert.equal(run.conclusion, 'success', 'Required workflow failed: ' + run.html_url);
  return true;
}
module.exports = { version, compare, nextPatch, validateUpdate, workflowSucceeded };
