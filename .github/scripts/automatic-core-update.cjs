// Runs only trusted main-branch code. Updated dependencies execute in separate
// read-only CI workflows, never in this job with repository write permissions.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { compare, nextPatch, validateUpdate, workflowSucceeded } = require('./core-update-policy.cjs');
const workflows = ['ci.yml', 'security.yml', 'desktop-windows.yml'];
const files = ['desktop/package.json', 'desktop/package-lock.json'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Run core maintenance from main only');
  const repo = process.env.GITHUB_REPOSITORY;
  assert(/^[\w.-]+\/[\w.-]+$/.test(repo || ''), 'Missing repository');
  const token = process.env.GH_TOKEN;
  assert(token, 'Missing workflow token');
  async function api(route, method = 'GET', data) {
    const response = await fetch('https://api.github.com/repos/' + repo + '/' + route, {
      method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('GitHub ' + method + ' ' + route.split('?')[0] + ': ' + response.status);
    return response.status === 204 ? null : response.json();
  }
  const summary = (line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n\n');
  };
  const baseSha = (await api('git/ref/heads/main')).object.sha;
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baseSha, 'Main moved; retry from its latest commit');
  const before = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const oldLock = JSON.parse(fs.readFileSync(files[1], 'utf8'));
  const metadataResponse = await fetch('https://registry.npmjs.org/electron/latest', { signal: AbortSignal.timeout(30_000) });
  assert(metadataResponse.ok, 'Cannot read the stable Electron release');
  const engine = (await metadataResponse.json()).version;
  if (compare(engine, before.devDependencies.electron) <= 0) {
    summary('Electron ' + before.devDependencies.electron + ' is current. No release needed.'); return;
  }
  const release = await api('releases/latest');
  assert.equal(release.tag_name, 'v' + before.version, 'An application release is already pending; finish it first');
  const sinceRelease = await api('compare/' + encodeURIComponent(release.tag_name) + '...' + baseSha);
  assert(sinceRelease.files && sinceRelease.files.length < 300, 'Cannot verify the complete release diff');
  assert(!sinceRelease.files.some((file) => file.filename.startsWith('desktop/') || file.filename === 'src/styles.css'), 'Unreleased desktop changes require a normal release first');
  const open = await api('pulls?state=open&per_page=100');
  const pending = open.filter((pr) => pr.head.ref.startsWith('agent/codex/core-update-'));
  assert(pending.length <= 1, 'Multiple core updates are pending; review them before continuing');
  let pr = pending[0];
  let headSha, after, newLock;
  if (pr) {
    assert.equal(pr.user.login, 'github-actions[bot]', 'Unexpected update author');
    assert.equal(pr.head.repo.full_name, repo, 'Unexpected update repository');
    headSha = pr.head.sha;
    const commit = await api('git/commits/' + headSha);
    assert.equal(commit.parents.length, 1, 'Unexpected update history');
    assert.equal(commit.parents[0].sha, baseSha, 'Main moved since the pending update; review or close that PR');
    const read = async (name) => JSON.parse(Buffer.from((await api('contents/' + name + '?ref=' + headSha)).content, 'base64').toString('utf8'));
    after = await read(files[0]); newLock = await read(files[1]);
  } else {
    after = structuredClone(before);
    after.version = nextPatch(before.version);
    after.devDependencies.electron = engine;
    fs.writeFileSync(files[0], JSON.stringify(after, null, 2) + '\n');
    // No package lifecycle hooks run in this privileged job.
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--save-dev', '--save-exact', 'electron@' + engine, '--registry=https://registry.npmjs.org'], { cwd: 'desktop', stdio: 'inherit' });
    after = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    newLock = JSON.parse(fs.readFileSync(files[1], 'utf8'));
    validateUpdate(before, after, oldLock, newLock, engine);
    assert.equal((await api('git/ref/heads/main')).object.sha, baseSha, 'Main moved; retry without publishing this update');
    const base = await api('git/commits/' + baseSha);
    const treeEntries = [];
    for (const name of files) {
      const blob = await api('git/blobs', 'POST', { content: fs.readFileSync(name).toString('base64'), encoding: 'base64' });
      treeEntries.push({ path: name, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const tree = await api('git/trees', 'POST', { base_tree: base.tree.sha, tree: treeEntries });
    const commit = await api('git/commits', 'POST', { message: 'chore: update Electron to ' + engine + ' and release ' + after.version, tree: tree.sha, parents: [baseSha] });
    headSha = commit.sha;
    const branch = 'agent/codex/core-update-' + after.version + '-' + process.env.GITHUB_RUN_ID;
    await api('git/refs', 'POST', { ref: 'refs/heads/' + branch, sha: headSha });
    pr = await api('pulls', 'POST', { base: 'main', head: branch, title: 'Electron ' + engine + ' → Umbra ' + after.version,
      body: 'Автоматическое обновление стабильного Electron с ' + before.devDependencies.electron + ' до ' + engine + '.\n\nИзменены только зависимость ядра, её lockfile и patch-версия приложения. Слияние разрешено только после проверки кода, аудита и Windows-сборки. Установщик публикуется после повторной проверки релизного тега; при любой ошибке выпуск останавливается.' });
  }
  const appVersion = validateUpdate(before, after, oldLock, newLock, engine);
  const changed = await api('pulls/' + pr.number + '/files?per_page=100');
  assert.deepEqual(changed.map((file) => file.filename).sort(), [...files].sort(), 'Unexpected PR files');
  summary('Checking [Electron ' + engine + ' / Umbra ' + appVersion + '](' + pr.html_url + ').');
  async function dispatchAndWait(names, ref, sha, inputs = {}) {
    const since = Date.now() - 1_000;
    // Token-generated PR/tag events are not relied on to start CI.
    for (const name of names) await api('actions/workflows/' + name + '/dispatches', 'POST', { ref, inputs });
    for (let attempt = 0; attempt < 80; attempt++) {
      let complete = true;
      for (const name of names) {
        const runs = await api('actions/workflows/' + name + '/runs?event=workflow_dispatch&per_page=50');
        if (!workflowSucceeded(runs.workflow_runs, sha, since)) complete = false;
      }
      if (complete) return;
      await delay(15_000);
    }
    throw new Error('Timed out waiting for required workflows; no unchecked release is allowed');
  }
  await dispatchAndWait(workflows, pr.head.ref, headSha);
  const fresh = await api('pulls/' + pr.number);
  assert.equal(fresh.state, 'open');
  assert.equal(fresh.head.sha, headSha, 'The update was edited during CI');
  assert.equal(fresh.base.ref, 'main');
  assert.equal((await api('git/ref/heads/main')).object.sha, baseSha, 'Main moved during CI; review the pending update');
  const tested = await api('git/commits/' + headSha);
  const merge = await api('pulls/' + pr.number + '/merge', 'PUT', { merge_method: 'merge', sha: headSha });
  assert(merge.merged, 'PR did not merge');
  const merged = await api('git/commits/' + merge.sha);
  assert.equal(merged.tree.sha, tested.tree.sha, 'Merged contents differ from tested contents; release stopped');
  assert(compare(appVersion, (await api('releases/latest')).tag_name.replace(/^v/, '')) > 0, 'A newer release already exists');
  const tag = 'v' + appVersion;
  await api('git/refs', 'POST', { ref: 'refs/tags/' + tag, sha: merge.sha });
  await dispatchAndWait(['desktop-windows.yml'], tag, merge.sha, { automatic_release: true });
  const published = await api('releases/tags/' + tag);
  assert(!published.draft && !published.prerelease, 'The automatic release was not published');
  summary('Published [' + tag + '](' + published.html_url + ') with Electron ' + engine + '. Installed clients will download it automatically.');
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
