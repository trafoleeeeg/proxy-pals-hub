const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compare, nextPatch, validateUpdate, workflowSucceeded } = require('./core-update-policy.cjs');
const { verify } = require('./verify-core-release.cjs');

function fixture() {
  const before = { name: 'umbra-desktop', version: '0.4.1', devDependencies: { electron: '44.3.0', builder: '1.0.0' }, build: { nsis: { deleteAppDataOnUninstall: false } } };
  const entry = (name, value) => ({ version: value, resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + value + '.tgz', integrity: 'sha512-YWJjZA==' });
  const oldLock = { name: before.name, version: before.version, lockfileVersion: 3, packages: { '': { version: before.version, devDependencies: before.devDependencies }, 'node_modules/electron': entry('electron', '44.3.0'), 'node_modules/builder': entry('builder', '1.0.0') } };
  const after = structuredClone(before), newLock = structuredClone(oldLock);
  after.version = '0.4.2'; after.devDependencies.electron = '44.4.1';
  newLock.version = newLock.packages[''].version = after.version;
  newLock.packages[''].devDependencies.electron = '44.4.1';
  newLock.packages['node_modules/electron'] = entry('electron', '44.4.1');
  return [before, after, oldLock, newLock, '44.4.1'];
}
test('stable versions compare numerically and bump the app patch', () => {
  assert.equal(compare('44.10.0', '44.4.1'), 1);
  assert.equal(compare('44.3.0', '44.4.1'), -1);
  assert.equal(nextPatch('0.4.9'), '0.4.10');
  for (const value of ['45.0.0-beta.1', '^44.3.0', '44.3', '44.03.0', '44.3.0\n']) assert.throws(() => compare(value, '44.3.0'));
});
test('accepts only the pinned engine and matching application/lock versions', () => {
  assert.equal(validateUpdate(...fixture()), '0.4.2');
  const values = fixture(); values[3].version = '0.4.1';
  assert.throws(() => validateUpdate(...values));
});
test('rejects unrelated application and dependency changes', () => {
  for (const mutate of [
    (v) => { v[1].build.nsis.deleteAppDataOnUninstall = true; },
    (v) => { v[1].devDependencies.builder = '2.0.0'; },
    (v) => { v[3].packages['node_modules/builder'].version = '2.0.0'; },
    (v) => { v[3].packages[''].devDependencies.builder = '2.0.0'; },
    (v) => { v[4] = '44.2.0'; },
  ]) { const values = fixture(); mutate(values); assert.throws(() => validateUpdate(...values)); }
});
test('accepts engine transitive dependencies but rejects unknown registries and missing integrity', () => {
  const values = fixture();
  values[3].packages['node_modules/electron'].dependencies = { helper: '^1.0.0' };
  values[3].packages['node_modules/helper'] = { version: '1.0.0', integrity: 'sha512-YWJjZA==', resolved: 'https://registry.npmjs.org/helper/-/helper-1.0.0.tgz' };
  assert.equal(validateUpdate(...values), '0.4.2');
  values[3].packages['node_modules/helper'].resolved = 'https://untrusted.example/helper.tgz';
  assert.throws(() => validateUpdate(...values));
  const missing = fixture(); delete missing[3].packages['node_modules/electron'].integrity;
  assert.throws(() => validateUpdate(...missing));
});
test('only completed successful workflows for the exact fresh commit permit release', () => {
  const run = { event: 'workflow_dispatch', head_sha: 'tested', status: 'completed', conclusion: 'success', created_at: '2026-09-17T00:00:00Z', html_url: 'https://github.com/example/run/1' };
  const since = Date.parse(run.created_at);
  assert.equal(workflowSucceeded([run], 'tested', since), true);
  assert.equal(workflowSucceeded([run], 'changed', since), false);
  assert.equal(workflowSucceeded([run], 'tested', since + 1000), false);
  assert.equal(workflowSucceeded([{ ...run, event: 'pull_request' }], 'tested', since), false);
  assert.equal(workflowSucceeded([{ ...run, status: 'in_progress' }], 'tested', since), false);
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', null]) {
    assert.throws(() => workflowSucceeded([{ ...run, conclusion }], 'tested', since));
  }
});

function provenance() {
  const result = {
    'git/ref/tags/v0.4.2': { object: { sha: 'merged' } },
    'commits/merged/pulls': [{ number: 1, merged_at: '2026-09-17', merge_commit_sha: 'merged', user: { login: 'github-actions[bot]' }, base: { ref: 'main' }, head: { sha: 'tested', ref: 'agent/codex/core-update-0.4.2-123', repo: { full_name: 'owner/repo' } } }],
    'pulls/1/files?per_page=100': [{ filename: 'desktop/package.json' }, { filename: 'desktop/package-lock.json' }],
    'git/commits/merged': { tree: { sha: 'same-tree' } },
    'git/commits/tested': { tree: { sha: 'same-tree' } },
    'releases/latest': { tag_name: 'v0.4.1' },
  };
  for (const name of ['ci.yml', 'security.yml', 'desktop-windows.yml']) {
    result['actions/workflows/' + name + '/runs?event=workflow_dispatch&per_page=100'] = { workflow_runs: [{ event: 'workflow_dispatch', head_sha: 'tested', status: 'completed', conclusion: 'success' }] };
  }
  return result;
}
test('publishes only the exact merged core update after all required checks', async () => {
  const data = provenance();
  await verify({ api: async (route) => structuredClone(data[route]), sha: 'merged', tag: 'v0.4.2', repo: 'owner/repo' });
});
test('rejects modified, untested, unrelated or superseded automatic releases', async () => {
  const ci = 'actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=100';
  for (const mutate of [
    (v) => { v['git/ref/tags/v0.4.2'].object.sha = 'moved'; },
    (v) => { v['git/commits/merged'].tree.sha = 'changed'; },
    (v) => { v['commits/merged/pulls'][0].user.login = 'someone'; },
    (v) => { v['pulls/1/files?per_page=100'].push({ filename: 'desktop/main.cjs' }); },
    (v) => { v[ci].workflow_runs[0].conclusion = 'failure'; },
    (v) => { v[ci].workflow_runs[0].head_sha = 'other'; },
    (v) => { v[ci].workflow_runs[0].status = 'queued'; },
    (v) => { v['releases/latest'].tag_name = 'v0.4.2'; },
    (v) => { v['releases/latest'].tag_name = 'v0.4.3'; },
  ]) {
    const data = provenance(); mutate(data);
    await assert.rejects(verify({ api: async (route) => structuredClone(data[route]), sha: 'merged', tag: 'v0.4.2', repo: 'owner/repo' }));
  }
});
